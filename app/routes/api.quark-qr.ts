import { initDatabase } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";

// 夸克 UC-CAS 扫码登录（与 AList/OpenList、LitePan 等项目同款流程）：
// 1. getTokenForQrcodeLogin 拿二维码 token；
// 2. 用户用夸克 App 扫码确认；
// 3. getServiceTicketByQrcodeToken 轮询到 service_ticket；
// 4. 带 st 访问 pan.quark.cn/account/info，吸收 Set-Cookie 里的 __pus/__puus 等登录 Cookie。
// Worker 服务端代发请求不受 CORS 限制，Cookie 只回传给发起会话的管理员前端填入表单。

const CAS_HOST = "https://uop.quark.cn";
const CAS_GET_TOKEN = "/cas/ajax/getTokenForQrcodeLogin";
const CAS_GET_TICKET = "/cas/ajax/getServiceTicketByQrcodeToken";
const PAN_HOST = "https://pan.quark.cn";
const PAN_ACCOUNT_INFO = "/account/info";
const DRIVE_HOST = "https://drive.quark.cn";
const QR_BASE_URL = "https://su.quark.cn/4_eMHBJ";
const CAS_CLIENT_ID = "532";
const CAS_STATUS_OK = 2000000;
const CAS_STATUS_FAIL = new Set([50004002, 50004003, 50004004]);
const QR_TIMEOUT_SEC = 300;
const POLL_INTERVAL_MS = 3000;
const LOGIN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

// 埋点类 Cookie 与登录无关，避免污染配置
const SKIP_COOKIE_NAMES = new Set(["_gid", "isg", "l"]);

interface CasResponse {
  status?: number;
  message?: string;
  data?: {
    members?: {
      token?: string;
      service_ticket?: string;
    };
  };
}

interface QrSession {
  token: string;
  casCookie: string;
  created: number;
}

function requestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function encodeB64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeB64Url(text: string): string {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeSession(session: QrSession): string {
  return encodeB64Url(
    JSON.stringify({ t: session.token, c: session.casCookie, ts: session.created })
  );
}

function decodeSession(raw: string): QrSession | null {
  try {
    const parsed = JSON.parse(decodeB64Url(raw)) as {
      t?: string;
      c?: string;
      ts?: number;
    };
    if (!parsed.t) return null;
    return { token: parsed.t, casCookie: parsed.c || "", created: parsed.ts || 0 };
  } catch {
    return null;
  }
}

function buildQrContent(token: string): string {
  const params = new URLSearchParams({
    token,
    client_id: CAS_CLIENT_ID,
    ssb: "weblogin",
    uc_param_str: "",
    uc_biz_str: "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0",
  });
  return `${QR_BASE_URL}?${params.toString()}`;
}

// 同名 Cookie 按域收敛：drive/pan 子域优先于通配根域（对齐夸克 App 实际下发顺序）
function domainScore(domain: string): number {
  let score = domain.length;
  if (domain.includes("drive")) score += 80;
  if (domain.includes("pan.quark")) score += 40;
  if (domain.startsWith(".")) score += 5;
  return score;
}

class CookieJar {
  private entries = new Map<string, { value: string; score: number }>();

  absorb(reqHost: string, setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || !value || SKIP_COOKIE_NAMES.has(name) || name.startsWith("_ga")) {
        continue;
      }
      let domain = reqHost;
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        if (k.trim().toLowerCase() === "domain" && v) domain = v.trim().toLowerCase();
      }
      if (!domain.includes("quark")) continue;
      const score = domainScore(domain);
      const current = this.entries.get(name);
      if (!current || score >= current.score) {
        this.entries.set(name, { value, score });
      }
    }
  }

  absorbPlain(cookieString: string): void {
    for (const part of cookieString.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name || !value || SKIP_COOKIE_NAMES.has(name) || name.startsWith("_ga")) continue;
      if (!this.entries.has(name)) this.entries.set(name, { value, score: 0 });
    }
  }

  header(): string {
    return Array.from(this.entries, ([name, e]) => `${name}=${e.value}`).join("; ");
  }

  // 必须含 __pus 才算登录成功，避免把游客 Cookie 填进配置
  isLoginCookie(): boolean {
    return this.entries.has("__pus");
  }
}

function readSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers) || [];
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// 手动跟随重定向：跨域跳转（pan→uop→pan）之间要保留并回带 Set-Cookie
async function fetchTrack(
  url: string,
  extraHeaders: Record<string, string>,
  jar: CookieJar
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const headers: Record<string, string> = {
      "User-Agent": LOGIN_UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...extraHeaders,
    };
    const cookie = jar.header();
    if (cookie) headers["Cookie"] = cookie;
    const resp = await fetch(current, { method: "GET", headers, redirect: "manual" });
    jar.absorb(new URL(current).hostname, readSetCookies(resp.headers));
    const location = resp.headers.get("location");
    if (isRedirect(resp.status) && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error("夸克登录重定向次数过多");
}

async function casRequest(query: URLSearchParams, jar: CookieJar): Promise<CasResponse> {
  const url = `${CAS_HOST}${query.has("token") ? CAS_GET_TICKET : CAS_GET_TOKEN}?${query.toString()}`;
  const resp = await fetchTrack(url, {
    Accept: "application/json, text/plain, */*",
    Referer: `${PAN_HOST}/`,
  }, jar);
  if (!resp.ok) throw new Error(`夸克 CAS 返回 HTTP ${resp.status}`);
  return (await resp.json()) as CasResponse;
}

// 用 service_ticket 换登录 Cookie：account/info 触发 Set-Cookie，再 bootstrap 补全 drive 域 Cookie
async function exchangeTicketForCookie(ticket: string, jar: CookieJar): Promise<string> {
  const infoUrl = `${PAN_HOST}${PAN_ACCOUNT_INFO}?${new URLSearchParams({ st: ticket, lw: "scan" }).toString()}`;
  const resp = await fetchTrack(infoUrl, { Accept: "application/json, text/plain, */*", Referer: `${PAN_HOST}/` }, jar);
  if (resp.status >= 400) {
    throw new Error(`获取登录 Cookie 失败（HTTP ${resp.status}）`);
  }
  try {
    await fetchTrack(`${PAN_HOST}/`, { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, jar);
  } catch {
    // 首页访问失败不影响主 Cookie，继续
  }
  try {
    const sortUrl = `${DRIVE_HOST}/1/clouddrive/file/sort?${new URLSearchParams({ pr: "ucpro", fr: "pc", pdir_fid: "0", _page: "1", _size: "1" }).toString()}`;
    await fetchTrack(sortUrl, {
      Accept: "application/json, text/plain, */*",
      Referer: `${PAN_HOST}/`,
    }, jar);
  } catch {
    // 列表接口偶发失败时 account/info 的 Cookie 通常已够用
  }
  if (!jar.isLoginCookie()) return "";
  return jar.header();
}

type QueryResult =
  | { status: "waiting" }
  | { status: "expired"; message: string }
  | { status: "failed"; message: string }
  | { status: "success"; cookie: string };

async function queryQrSession(session: QrSession): Promise<QueryResult> {
  if (Date.now() / 1000 - session.created > QR_TIMEOUT_SEC) {
    return { status: "expired", message: "二维码已过期，请重新获取" };
  }
  const jar = new CookieJar();
  if (session.casCookie) jar.absorbPlain(session.casCookie);
  let cas: CasResponse;
  try {
    cas = await casRequest(
      new URLSearchParams({
        client_id: CAS_CLIENT_ID,
        v: "1.2",
        token: session.token,
        request_id: requestId(),
      }),
      jar
    );
  } catch {
    // 网络抖动按等待处理，让前端继续轮询
    return { status: "waiting" };
  }
  const ticket = cas?.data?.members?.service_ticket || "";
  if (cas.status === CAS_STATUS_OK && ticket) {
    const cookie = await exchangeTicketForCookie(ticket, jar);
    if (!cookie) {
      return { status: "failed", message: "登录完成但未获取到 Cookie，请重试" };
    }
    return { status: "success", cookie };
  }
  if (cas.status !== undefined && CAS_STATUS_FAIL.has(cas.status)) {
    return { status: "failed", message: cas.message || "扫码登录失败" };
  }
  return { status: "waiting" };
}

// POST /api/quark-qr (JSON {action:"start"}) → 返回二维码内容与轮询凭证
export async function action({ request, context }: { request: Request; context: { cloudflare: { env: Env } } }) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  // 必须管理员：Cookie 属于夸克账号凭据，且轮询接口会回传完整 Cookie
  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "start") {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  try {
    const jar = new CookieJar();
    const cas = await casRequest(
      new URLSearchParams({
        client_id: CAS_CLIENT_ID,
        v: "1.2",
        request_id: requestId(),
      }),
      jar
    );
    const token = cas?.data?.members?.token || "";
    if (cas.status !== CAS_STATUS_OK || !token) {
      return Response.json(
        { error: cas.message || "获取夸克登录二维码失败" },
        { status: 502 }
      );
    }
    return Response.json({
      session: encodeSession({ token, casCookie: jar.header(), created: Math.floor(Date.now() / 1000) }),
      qrUrl: buildQrContent(token),
      expiresIn: QR_TIMEOUT_SEC,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  } catch (e: any) {
    return Response.json({ error: e.message || "发起夸克扫码登录失败" }, { status: 502 });
  }
}

// GET /api/quark-qr?action=query&session=... → 轮询扫码状态；成功后返回可填入配置的 Cookie
export async function loader({ request, context }: { request: Request; context: { cloudflare: { env: Env } } }) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get("action") !== "query") {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }
  const session = decodeSession(url.searchParams.get("session") || "");
  if (!session) {
    return Response.json({ error: "扫码会话无效，请重新获取二维码" }, { status: 400 });
  }

  try {
    return Response.json(await queryQrSession(session));
  } catch (e: any) {
    return Response.json({ status: "failed", message: e.message || "查询扫码状态失败" });
  }
}
