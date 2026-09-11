import type { Route } from "./+types/api.onedrive-oauth";
import { initDatabase, getStorageById, updateStorage } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";

// OneDrive 原生 OAuth 流：
// 1. 管理员在存储表单点「通过 Microsoft 授权」→ POST action=start → 返回授权 URL
// 2. 浏览器跳转 Microsoft 授权页 → 重定向回本路由的 loader（GET，公开）
// 3. 回调校验 state 签名后换 code → 存 refresh_token 到该存储的 config/saving

const ONEDRIVE_OAUTH_ENDPOINTS: Record<string, { oauth: string; token: string; scope: string }> = {
  global: {
    oauth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.All offline_access",
  },
  cn: {
    oauth: "https://login.chinacloudapi.cn/common/oauth2/v2.0/authorize",
    token: "https://login.chinacloudapi.cn/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.All offline_access",
  },
  us: {
    oauth: "https://login.microsoftonline.us/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.us/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.All offline_access",
  },
  de: {
    oauth: "https://login.microsoftonline.de/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.de/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.All offline_access",
  },
};

function getOAuthConfig(env: Env) {
  return {
    clientId: env.ONEDRIVE_CLIENT_ID?.trim() || "",
    clientSecret: env.ONEDRIVE_CLIENT_SECRET?.trim() || "",
    redirectUri: env.ONEDRIVE_REDIRECT_URI?.trim() || "",
  };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signState(secret: string, storageId: number, region: string): Promise<string> {
  const sig = await hmacHex(secret, `onedrive:${region}:${storageId}`);
  return `${storageId}.${region}.${sig}`;
}

async function verifyState(secret: string, state: string): Promise<{ storageId: number; region: string } | null> {
  const parts = state.split(".");
  if (parts.length < 3) {
    return null;
  }
  const storageId = parseInt(parts[0], 10);
  const region = parts[1];
  const sig = parts.slice(2).join(".");
  if (!Number.isFinite(storageId) || storageId <= 0 || !region) {
    return null;
  }
  const expected = await hmacHex(secret, `onedrive:${region}:${storageId}`);
  if (sig.length !== expected.length) {
    return null;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? { storageId, region } : null;
}

// GET：Microsoft 授权回调（公开）
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const homeUrl = "/";

  async function redirectHome(ok: boolean, reason?: string): Promise<Response> {
    const params = new URLSearchParams();
    params.set("oauth", ok ? "microsoft-success" : "microsoft-error");
    if (reason) {
      params.set("reason", reason);
    }
    const html = `<!DOCTYPE html><html><body><script>
      try { window.opener.postMessage({type:'oauth',provider:'microsoft',success:${ok}},'*'); } catch(e){}
      window.location.href = '/?${params.toString()}';
    </script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  }

  try {
    await initDatabase(db);

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error");
    const oauth = getOAuthConfig(context.cloudflare.env);

    if (error || !code) {
      return redirectHome(false, error || "缺少授权码");
    }
    if (!oauth.clientId || !oauth.clientSecret) {
      return redirectHome(false, "未配置 ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET");
    }

    const parsed = await verifyState(oauth.clientSecret, state);
    if (!parsed) {
      return redirectHome(false, "授权状态校验失败，请重新发起");
    }
    const { storageId, region } = parsed;

    const storage = await getStorageById(db, storageId);
    if (!storage || storage.type !== "onedrive") {
      return redirectHome(false, "存储不存在，请刷新后重试");
    }

    const host = ONEDRIVE_OAUTH_ENDPOINTS[region] || ONEDRIVE_OAUTH_ENDPOINTS.global;

    const formData = new URLSearchParams();
    formData.append("grant_type", "authorization_code");
    formData.append("code", code);
    formData.append("client_id", oauth.clientId);
    formData.append("client_secret", oauth.clientSecret);
    formData.append("redirect_uri", oauth.redirectUri || `${url.origin}/api/onedrive-oauth`);
    formData.append("scope", host.scope);

    const res = await fetch(host.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || data.error) {
      return redirectHome(false, data.error_description || data.error || "换取令牌失败");
    }
    if (!data.access_token || !data.refresh_token) {
      return redirectHome(false, "授权响应缺少 refresh_token，请重试");
    }

    const now = Date.now();
    await updateStorage(db, storageId, {
      config: {
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: data.refresh_token,
        use_online_api: false,
        region: storage.config?.region || region,
        is_sharepoint: storage.config?.is_sharepoint || false,
        ...(storage.config?.site_id ? { site_id: storage.config.site_id } : {}),
        ...(storage.config?.root_folder_path ? { root_folder_path: storage.config.root_folder_path } : {}),
        ...(storage.config?.chunk_size ? { chunk_size: storage.config.chunk_size } : {}),
        ...(storage.config?.custom_host ? { custom_host: storage.config.custom_host } : {}),
      },
      saving: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: now + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000),
      },
    });

    return redirectHome(true);
  } catch (err) {
    return redirectHome(false, err instanceof Error ? err.message : "授权保存失败");
  }
}

// POST：发起授权 / 查询配置状态（需管理员）
export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  const oauth = getOAuthConfig(context.cloudflare.env);

  if (body.action === "status") {
    const storageId = Number(body.storageId || 0);
    const storage = storageId ? await getStorageById(db, storageId) : null;
    return Response.json({
      configured: Boolean(oauth.clientId && oauth.clientSecret),
      authorized: Boolean(
        storage &&
          typeof storage.config?.refresh_token === "string" &&
          storage.config.refresh_token
      ),
    });
  }

  if (body.action === "start") {
    const storageId = Number(body.storageId || 0);
    const storage = storageId ? await getStorageById(db, storageId) : null;
    if (!storage || storage.type !== "onedrive") {
      return Response.json({ error: "请先保存一个 OneDrive 类型的存储" }, { status: 400 });
    }
    if (!oauth.clientId) {
      return Response.json(
        { error: "未配置 ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET，无法发起授权" },
        { status: 400 }
      );
    }

    const region = storage.config?.region || "global";
    const host = ONEDRIVE_OAUTH_ENDPOINTS[region] || ONEDRIVE_OAUTH_ENDPOINTS.global;
    const state = await signState(oauth.clientSecret, storageId, region);
    const redirectUri = oauth.redirectUri || `${new URL(request.url).origin}/api/onedrive-oauth`;

    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: host.scope,
      prompt: "consent",
      state,
    });

    return Response.json({ url: `${host.oauth}?${params.toString()}` });
  }

  return Response.json({ error: "未知操作" }, { status: 400 });
}