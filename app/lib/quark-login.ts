export const QUARK_QR_TTL_SEC = 300;
export const QUARK_QR_POLL_MS = 3000;
export const QUARK_FETCH_TIMEOUT_MS = 15_000;

export const LOGIN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

export const CAS_HOST = "https://uop.quark.cn";
export const CAS_GET_TOKEN = "/cas/ajax/getTokenForQrcodeLogin";
export const CAS_GET_TICKET = "/cas/ajax/getServiceTicketByQrcodeToken";
export const PAN_HOST = "https://pan.quark.cn";
export const PAN_ACCOUNT_INFO = "/account/info";
export const DRIVE_HOST = "https://drive.quark.cn";
export const QR_BASE_URL = "https://su.quark.cn/4_eMHBJ";
export const CAS_CLIENT_ID = "532";
export const CAS_STATUS_OK = 2000000;
export const CAS_STATUS_FAIL = new Set([50004002, 50004003, 50004004]);

// 埋点类 Cookie 与登录无关，避免污染配置
export const SKIP_COOKIE_NAMES = new Set(["_gid", "isg", "l"]);

export interface CasResponse {
  status?: number;
  message?: string;
  data?: {
    members?: {
      token?: string;
      service_ticket?: string;
    };
  };
}

export interface QrSession {
  token: string;
  casCookie: string;
  created: number;
}

export interface QueryResult {
  status: "waiting" | "expired" | "failed" | "success";
  cookie?: string;
  message?: string;
}

export function requestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeB64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeB64Url(text: string): string {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeSession(session: QrSession): string {
  return encodeB64Url(
    JSON.stringify({ t: session.token, c: session.casCookie, ts: session.created })
  );
}

export function decodeSession(raw: string): QrSession | null {
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

export function buildQrContent(token: string): string {
  const params = new URLSearchParams({
    token,
    client_id: CAS_CLIENT_ID,
    ssb: "weblogin",
    uc_param_str: "",
    uc_biz_str:
      "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0",
  });
  return `${QR_BASE_URL}?${params.toString()}`;
}

export function domainScore(domain: string): number {
  let score = domain.length;
  if (domain.includes("drive")) score += 80;
  if (domain.includes("pan.quark")) score += 40;
  if (domain.startsWith(".")) score += 5;
  return score;
}

export class CookieJar {
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

  isLoginCookie(): boolean {
    return this.entries.has("__pus");
  }
}

export function readSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers) || [];
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// 手动跟随重定向：跨域跳转（pan→uop→pan）之间保留并回带 Set-Cookie
export async function fetchTrack(
  url: string,
  extraHeaders: Record<string, string>,
  jar: CookieJar,
  signal?: AbortSignal
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
    const merged = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(QUARK_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(QUARK_FETCH_TIMEOUT_MS);
    const resp = await fetch(current, { method: "GET", headers, redirect: "manual", signal: merged });
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

export async function casRequest(query: URLSearchParams, jar: CookieJar, signal?: AbortSignal): Promise<CasResponse> {
  const url = `${CAS_HOST}${query.has("token") ? CAS_GET_TICKET : CAS_GET_TOKEN}?${query.toString()}`;
  const resp = await fetchTrack(url, {
    Accept: "application/json, text/plain, */*",
    Referer: `${PAN_HOST}/`,
  }, jar, signal);
  if (!resp.ok) throw new Error(`夸克 CAS 返回 HTTP ${resp.status}`);
  return (await resp.json()) as CasResponse;
}

export async function exchangeTicketForCookie(ticket: string, jar: CookieJar, signal?: AbortSignal): Promise<string> {
  const infoUrl = `${PAN_HOST}${PAN_ACCOUNT_INFO}?${new URLSearchParams({ st: ticket, lw: "scan" }).toString()}`;
  const resp = await fetchTrack(infoUrl, { Accept: "application/json, text/plain, */*", Referer: `${PAN_HOST}/` }, jar, signal);
  if (resp.status >= 400) {
    throw new Error(`获取登录 Cookie 失败（HTTP ${resp.status}）`);
  }
  try {
    await fetchTrack(`${PAN_HOST}/`, { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, jar, signal);
  } catch {
    // 首页访问失败不影响主 Cookie，继续
  }
  try {
    const sortUrl = `${DRIVE_HOST}/1/clouddrive/file/sort?${new URLSearchParams({ pr: "ucpro", fr: "pc", pdir_fid: "0", _page: "1", _size: "1" }).toString()}`;
    await fetchTrack(sortUrl, {
      Accept: "application/json, text/plain, */*",
      Referer: `${PAN_HOST}/`,
    }, jar, signal);
  } catch {
    // 列表接口偶发失败时 account/info 的 Cookie 通常已够用
  }
  if (!jar.isLoginCookie()) return "";
  return jar.header();
}

export async function queryQrSession(session: QrSession, signal?: AbortSignal): Promise<QueryResult> {
  const jar = new CookieJar();
  jar.absorbPlain(session.casCookie);
  let result: QueryResult = { status: "waiting" };

  const q = new URLSearchParams({ client_id: CAS_CLIENT_ID, v: "1.2", request_id: requestId(), token: session.token });
  const cas = await casRequest(q, jar, signal);
  const members = cas.data?.members;
  if (members?.service_ticket) {
    const cookie = await exchangeTicketForCookie(members.service_ticket, jar, signal);
    if (cookie) {
      result = { status: "success", cookie };
    } else {
      result = { status: "failed", message: "未获取到有效登录 Cookie" };
    }
  } else if (typeof cas.status === "number" && CAS_STATUS_FAIL.has(cas.status)) {
    result = { status: "failed", message: cas.message || "扫码登录失败" };
  } else if (cas.status === CAS_STATUS_OK && members?.token && members.token !== session.token) {
    result = { status: "failed", message: "登录会话已变更，请重新获取二维码" };
  }

  return result;
}
