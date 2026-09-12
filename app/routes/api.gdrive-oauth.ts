import type { Route } from "./+types/api.gdrive-oauth";
import { initDatabase, getStorageById, updateStorage } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";

// Google Drive 原生 OAuth 流：
// 1. 管理员在存储表单点「通过 Google 授权」→ POST action=start → 返回授权 URL
// 2. 浏览器跳转 Google 授权页 → Google 重定向回本路由的 loader（GET，公开）
// 3. 回调校验 state 签名后换 code → 存 refresh_token 到该存储的 config/saving

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

function getOAuthConfig(env: Env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID?.trim() || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || "",
    redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || "",
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

async function signState(secret: string, storageId: number): Promise<string> {
  const sig = await hmacHex(secret, `gdrive:${storageId}`);
  return `${storageId}.${sig}`;
}

async function verifyState(secret: string, state: string): Promise<number | null> {
  const dot = state.indexOf(".");
  if (dot < 1) {
    return null;
  }
  const storageId = parseInt(state.slice(0, dot), 10);
  const sig = state.slice(dot + 1);
  if (!Number.isFinite(storageId) || storageId <= 0) {
    return null;
  }
  const expected = await hmacHex(secret, `gdrive:${storageId}`);
  if (sig.length !== expected.length) {
    return null;
  }
  // 恒定时间比较，避免时序侧信道
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? storageId : null;
}

// GET：Google 授权回调（公开）
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error");
  const oauth = getOAuthConfig(context.cloudflare.env);
  const homeUrl = "/";

  async function redirectHome(ok: boolean, reason?: string): Promise<Response> {
    const params = new URLSearchParams();
    params.set("oauth", ok ? "google-success" : "google-error");
    if (reason) {
      params.set("reason", reason);
    }
    // 先发 postMessage 给父窗口，再在当前页面跳转；targetOrigin 限定当前站点
    const html = `<!DOCTYPE html><html><body><script>
      try { window.opener.postMessage({type:'oauth',provider:'google',success:${ok}}, window.location.origin); } catch(e){}
      window.location.href = '/?${params.toString()}';
    </script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  }

  if (error || !code) {
    return redirectHome(false, error || "缺少授权码");
  }
  if (!oauth.clientId || !oauth.clientSecret) {
    return redirectHome(false, "未配置 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  }

  const storageId = await verifyState(oauth.clientSecret, state);
  if (!storageId) {
    return redirectHome(false, "授权状态校验失败，请重新发起");
  }

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return redirectHome(false, "存储不存在，请刷新后重试");
  }

  try {
    const formData = new URLSearchParams();
    formData.append("grant_type", "authorization_code");
    formData.append("code", code);
    formData.append("client_id", oauth.clientId);
    formData.append("client_secret", oauth.clientSecret);
    formData.append("redirect_uri", oauth.redirectUri || `${url.origin}/api/gdrive-oauth`);

    const res = await fetch(GOOGLE_TOKEN_URL, {
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
      return redirectHome(false, "授权响应缺少 refresh_token，请授权后重试");
    }

    const now = Date.now();
    await updateStorage(db, storageId, {
      config: {
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: data.refresh_token,
        // 原生 OAuth 使用本地客户端凭据走官方接口刷新，避免依赖在线聚合 API
        use_online_api: false,
        // 已有手动配置保留
        ...(storage.config?.root_folder_id ? { root_folder_id: storage.config.root_folder_id } : {}),
        ...(storage.config?.order_by ? { order_by: storage.config.order_by } : {}),
        ...(storage.config?.order_direction ? { order_direction: storage.config.order_direction } : {}),
        ...(storage.config?.chunk_size ? { chunk_size: storage.config.chunk_size } : {}),
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

  // 查询 OAuth 是否已配置 + 当前存储的授权状态
  if (body.action === "status") {
    const storageId = Number(body.storageId || 0);
    const storage = storageId
      ? await getStorageById(db, storageId)
      : null;
    return Response.json({
      configured: Boolean(oauth.clientId && oauth.clientSecret),
      authorized: Boolean(
        storage &&
          typeof storage.config?.refresh_token === "string" &&
          storage.config.refresh_token
      ),
    });
  }

  // 发起授权：返回 Google 授权页 URL
  if (body.action === "start") {
    const storageId = Number(body.storageId || 0);
    const storage = storageId ? await getStorageById(db, storageId) : null;
    if (!storage || storage.type !== "gdrive") {
      return Response.json({ error: "请先保存一个 Google Drive 类型的存储" }, { status: 400 });
    }
    if (!oauth.clientId || !oauth.clientSecret) {
      return Response.json(
        { error: "未配置 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，无法发起授权" },
        { status: 400 }
      );
    }

    const state = await signState(oauth.clientSecret, storageId);
    const redirectUri =
      oauth.redirectUri || `${new URL(request.url).origin}/api/gdrive-oauth`;

    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });

    return Response.json({ url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
  }

  return Response.json({ error: "未知操作" }, { status: 400 });
}
