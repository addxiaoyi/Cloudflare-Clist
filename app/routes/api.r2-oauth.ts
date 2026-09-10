import {
  initDatabase,
  getStorageById,
  updateStorage,
} from "~/lib/storage";

// Cloudflare OAuth 端点
const CF_OAUTH_ENDPOINTS = {
  oauth: "https://auth.cloudflare.com/",
  token: "https://api.cloudflare.com/client/v4/user/tokens",
};

// R2 OAuth 范围
const CF_R2_SCOPES = ["r2:obj_read", "r2:obj_write", "r2:obj_list"];

function getOAuthConfig(env: Env) {
  return {
    clientId: env.CF_CLIENT_ID?.trim() || "",
    clientSecret: env.CF_CLIENT_SECRET?.trim() || "",
    redirectUri: env.CF_REDIRECT_URI?.trim() || "",
  };
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signState(secret: string, storageId: number): Promise<string> {
  const sig = await hmac(secret, `r2:${storageId}`);
  return `${storageId}.${sig}`;
}

async function verifyState(secret: string, state: string): Promise<number | null> {
  const parts = state.split(".");
  if (parts.length < 2) {
    return null;
  }
  const storageId = parseInt(parts[0], 10);
  const sig = parts.slice(1).join(".");
  if (!Number.isFinite(storageId) || storageId <= 0) {
    return null;
  }
  const expected = await hmac(secret, `r2:${storageId}`);
  if (sig.length !== expected.length) {
    return null;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? storageId : null;
}

// POST /api/r2-oauth?action=start → 返回授权 URL
export async function action({ request, context }: { request: Request; context: { cloudflare: { env: Env } } }) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const formData = await request.formData();
  const action = formData.get("action") as string;

  if (action !== "start") {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  const storageId = parseInt(formData.get("storageId") as string, 10);
  const storage = await getStorageById(db, storageId);
  if (!storage || storage.type !== "r2-oauth") {
    return Response.json({ error: "Storage not found or not r2-oauth type" }, { status: 404 });
  }

  const oauth = getOAuthConfig(context.cloudflare.env);
  if (!oauth.clientId) {
    return Response.json({ error: "CF_CLIENT_ID 未配置" }, { status: 500 });
  }

  const state = await signState(oauth.clientSecret || "default-secret", storageId);
  const scope = CF_R2_SCOPES.join(" ");
  const origin = new URL(request.url).origin;
  const redirectUri = oauth.redirectUri || `${origin}/api/r2-oauth`;
  const url = `${CF_OAUTH_ENDPOINTS.oauth}?client_id=${encodeURIComponent(oauth.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;

  return Response.json({ url, state });
}

// GET /api/r2-oauth?code=...&state=... → 回调处理
export async function loader({ request, context }: { request: Request; context: { cloudflare: { env: Env } } }) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error");

  const oauth = getOAuthConfig(context.cloudflare.env);
  const homeUrl = "/";

  async function redirectHome(ok: boolean, reason?: string): Promise<Response> {
    const payload = { type: "oauth", provider: "cloudflare", success: ok, reason: reason || "" };
    const params = new URLSearchParams();
    params.set("oauth", ok ? "cloudflare-success" : "cloudflare-error");
    if (reason) {
      params.set("reason", reason);
    }
    const targetUrl = `${homeUrl}?${params.toString()}`;
    // JSON.stringify 后额外转义 "<"，防止 reason 含 "</script>" 跳出脚本标签
    const jsonSafe = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
    // targetOrigin 使用当前站点 origin，避免向任意来源泄漏
    const html = `<!DOCTYPE html><html><body><script>
      try { window.opener && window.opener.postMessage(${jsonSafe(payload)}, window.location.origin); } catch(e){}
      window.location.href = ${jsonSafe(targetUrl)};
    </` + `script></body></html>`;
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (error || !code) {
    return redirectHome(false, error || "缺少授权码");
  }

  if (!oauth.clientId || !oauth.clientSecret) {
    return redirectHome(false, "未配置 CF_CLIENT_ID / CF_CLIENT_SECRET");
  }

  const storageId = await verifyState(oauth.clientSecret || "default-secret", state);
  if (!storageId) {
    return redirectHome(false, "授权状态校验失败，请重新发起");
  }

  // 交换 code 为 access token
  try {
    const tokenResponse = await fetch(CF_OAUTH_ENDPOINTS.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${oauth.clientId}:${oauth.clientSecret}`)}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: oauth.redirectUri || "",
      }),
    });

    const tokenData: Record<string, any> = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      return redirectHome(false, tokenData.error || "获取 token 失败");
    }

    // 保存 token 到存储配置
    const storage = await getStorageById(db, storageId);
    if (storage) {
      await updateStorage(db, storageId, {
        config: {
          ...storage.config,
          cloudflare_access_token: tokenData.access_token,
          cloudflare_account_id: tokenData.account_id || "",
        },
        saving: {
          last_oauth_time: new Date().toISOString(),
          token_type: tokenData.token_type || "bearer",
          expires_in: tokenData.expires_in || 0,
        },
      });
    }

    return redirectHome(true);
  } catch (e: any) {
    return redirectHome(false, e.message);
  }
}