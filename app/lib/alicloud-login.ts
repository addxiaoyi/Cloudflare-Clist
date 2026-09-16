export const ALICLOUD_QR_TTL_SEC = 300;
export const ALICLOUD_QR_POLL_MS = 3000;
export const ALICLOUD_FETCH_TIMEOUT_MS = 15000;

export interface AlicloudQrSession {
  token: string;
  clientId: string;
  created: number;
}

export interface AlicloudQueryResult {
  status: 'waiting' | 'expired' | 'failed' | 'success';
  code?: string;
  message?: string;
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

export function encodeAlicloudSession(session: AlicloudQrSession): string {
  return encodeB64Url(
    JSON.stringify({
      t: session.token,
      c: session.clientId,
      ts: session.created,
    }),
  );
}

export function decodeAlicloudSession(raw: string): AlicloudQrSession | null {
  try {
    const parsed = JSON.parse(decodeB64Url(raw)) as {
      t?: string;
      c?: string;
      ts?: number;
    };
    if (!parsed.t || !parsed.c) return null;
    return {
      token: parsed.t,
      clientId: parsed.c,
      created: parsed.ts || 0,
    };
  } catch {
    return null;
  }
}

export async function fetchTrack(
  url: string,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extraHeaders,
  };
  const merged = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ALICLOUD_FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(ALICLOUD_FETCH_TIMEOUT_MS);
  return fetch(url, {
    method: 'GET',
    headers,
    redirect: 'manual',
    signal: merged,
  });
}

export async function createAlicloudQrCode(
  clientId: string,
  signal?: AbortSignal,
): Promise<{ token: string; qrCodeUrl: string }> {
  const url = `https://openapi.alipan.com/oauth/qrcode?client_id=${encodeURIComponent(clientId)}`;
  const resp = await fetchTrack(url, { Accept: 'application/json' }, signal);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`阿里云盘获取二维码失败（HTTP ${resp.status}）：${text}`);
  }
  const data = (await resp.json()) as {
    code?: string;
    message?: string;
    qr_code_url?: string;
    token?: string;
  };
  if (data.code && data.code !== 'QRCodeSuccess') {
    throw new Error(data.message || '阿里云盘获取二维码失败');
  }
  if (!data.qr_code_url || !data.token) {
    throw new Error(data.message || '阿里云盘获取二维码失败');
  }
  return { qrCodeUrl: data.qr_code_url, token: data.token };
}

export async function checkAlicloudQrStatus(
  token: string,
  signal?: AbortSignal,
): Promise<AlicloudQueryResult> {
  const url = `https://openapi.alipan.com/oauth/qrcode/status?token=${encodeURIComponent(token)}`;
  const resp = await fetchTrack(url, { Accept: 'application/json' }, signal);
  if (!resp.ok) {
    return { status: 'failed', message: `HTTP ${resp.status}` };
  }
  const data = (await resp.json()) as {
    code?: string;
    message?: string;
    authorization_code?: string;
  };
  if (data.code === 'QRCodeExpired') {
    return { status: 'expired' };
  }
  if (data.code === 'QRCodeCancelled') {
    return { status: 'failed', message: '用户取消了扫码' };
  }
  if (data.authorization_code) {
    return { status: 'success', code: data.authorization_code };
  }
  return { status: 'waiting' };
}

export async function exchangeAlicloudCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const resp = await fetch('https://openapi.alipan.com/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal: signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(ALICLOUD_FETCH_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(ALICLOUD_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`兑换阿里云盘令牌失败（HTTP ${resp.status}）：${text}`);
  }
  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    message?: string;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error(data.message || '兑换阿里云盘令牌失败');
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 7200,
  };
}
