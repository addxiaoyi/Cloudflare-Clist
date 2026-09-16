export const BAIDU_QR_TTL_SEC = 300;
export const BAIDU_QR_POLL_MS = 3000;
export const BAIDU_FETCH_TIMEOUT_MS = 15000;

export const BAIDU_LOGIN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export interface BaiduQrSession {
  sign: string;
  gid: string;
  baiduid: string;
  created: number;
}

export interface BaiduQueryResult {
  status: 'waiting' | 'expired' | 'failed' | 'success';
  cookie?: string;
  message?: string;
}

export function generateGid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
}

export function encodeB64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeB64Url(text: string): string {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeBaiduSession(session: BaiduQrSession): string {
  return encodeB64Url(
    JSON.stringify({
      s: session.sign,
      g: session.gid,
      b: session.baiduid,
      ts: session.created,
    }),
  );
}

export function decodeBaiduSession(raw: string): BaiduQrSession | null {
  try {
    const parsed = JSON.parse(decodeB64Url(raw)) as {
      s?: string;
      g?: string;
      b?: string;
      ts?: number;
    };
    if (!parsed.s || !parsed.g) return null;
    return {
      sign: parsed.s,
      gid: parsed.g,
      baiduid: parsed.b || '',
      created: parsed.ts || 0,
    };
  } catch {
    return null;
  }
}

export async function fetchTrack(
  url: string,
  extraHeaders: Record<string, string>,
  cookies: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': BAIDU_LOGIN_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extraHeaders,
  };
  if (Object.keys(cookies).length > 0) {
    headers['Cookie'] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  const merged = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(BAIDU_FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(BAIDU_FETCH_TIMEOUT_MS);
  return fetch(url, {
    method: 'GET',
    headers,
    redirect: 'manual',
    signal: merged,
  });
}

export async function getBaiduQrCode(
  cookies: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ sign: string; gid: string; baiduid: string; imgurl: string }> {
  const gid = generateGid();
  const resp = await fetchTrack(
    'https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrlogin=1',
    { Accept: 'application/json, text/plain, */*' },
    cookies,
    signal,
  );
  if (!resp.ok) {
    throw new Error(`百度获取二维码失败（HTTP ${resp.status}）`);
  }
  const data = (await resp.json()) as {
    errno?: number;
    sign?: string;
    imgurl?: string;
    message?: string;
  };
  if (data.errno !== 0 || !data.sign) {
    throw new Error(data.message || '百度获取二维码失败');
  }
  const baiduid =
    resp.headers.get('set-cookie')?.match(/BAIDUID=([^;]+)/)?.[1] || '';
  return {
    sign: data.sign,
    gid,
    baiduid,
    imgurl: data.imgurl || '',
  };
}

export async function checkBaiduQrStatus(
  sign: string,
  gid: string,
  baiduid: string,
  signal?: AbortSignal,
): Promise<BaiduQueryResult> {
  const cookies: Record<string, string> = {};
  if (baiduid) cookies['BAIDUID'] = baiduid;

  const t = Date.now();
  const resp = await fetchTrack(
    `https://passport.baidu.com/v2/api/qrcodecheck?qrcode_hash=${sign}&gid=${gid}&t=${t}&src=pc_act&sign=0`,
    { Accept: 'application/json, text/plain, */*' },
    cookies,
    signal,
  );
  if (!resp.ok) {
    return { status: 'failed', message: `HTTP ${resp.status}` };
  }
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('image/png')) {
    return { status: 'waiting' };
  }
  try {
    const data = (await resp.json()) as {
      errno?: number;
      status?: number;
      vcode?: string;
      message?: string;
    };
    if (data.status === 0) {
      return { status: 'waiting' };
    }
    if (data.status === 1) {
      return { status: 'waiting', message: '已扫码，请在手机上确认' };
    }
    if (data.status === 2 && data.vcode) {
      return { status: 'success', cookie: data.vcode };
    }
    return { status: 'failed', message: data.message || '未知状态' };
  } catch {
    return { status: 'failed', message: '解析响应失败' };
  }
}

export async function getBaiduAuthTicket(
  sign: string,
  gid: string,
  baiduid: string,
  signal?: AbortSignal,
): Promise<string> {
  const cookies: Record<string, string> = {};
  if (baiduid) cookies['BAIDUID'] = baiduid;

  const t = Date.now();
  const resp = await fetchTrack(
    `https://passport.baidu.com/v2/api/getauth?qrcode_hash=${sign}&gid=${gid}&t=${t}&src=pc_act&sign=0`,
    { Accept: 'application/json, text/plain, */*' },
    cookies,
    signal,
  );
  if (!resp.ok) {
    throw new Error(`获取百度授权票据失败（HTTP ${resp.status}）`);
  }
  const data = (await resp.json()) as {
    errno?: number;
    vcode?: string;
    message?: string;
  };
  if (data.errno !== 0 || !data.vcode) {
    throw new Error(data.message || '获取百度授权票据失败');
  }
  return data.vcode;
}

export async function exchangeBaiduTicketForCookies(
  ticket: string,
  gid: string,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetchTrack(
    `https://passport.baidu.com/v2/api/getticket?ticket=${encodeURIComponent(ticket)}&gid=${gid}`,
    { Accept: 'application/json, text/plain, */*' },
    {},
    signal,
  );
  if (!resp.ok) {
    throw new Error(`兑换百度 Cookie 失败（HTTP ${resp.status}）`);
  }
  const data = (await resp.json()) as {
    errno?: number;
    cookie?: string;
    message?: string;
  };
  if (data.errno !== 0 || !data.cookie) {
    throw new Error(data.message || '兑换百度 Cookie 失败');
  }
  return data.cookie;
}
