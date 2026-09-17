import { describe, expect, test, vi, beforeEach } from 'vitest';
import { encodeB64Url } from '~/lib/quark-login';

describe('Quark QR Login Smoke', () => {
  test('encodeSession/decodeSession round-trip', async () => {
    const { encodeSession, decodeSession } = await import('~/lib/quark-login');
    const session = {
      token: 'test-token-123',
      casCookie: 'CAS_TOKEN=abc; PATH=/',
      created: 1_700_000_000,
    };
    const encoded = encodeSession(session);
    expect(encoded).toBeTruthy();
    expect(typeof encoded).toBe('string');
    const decoded = decodeSession(encoded);
    expect(decoded).toEqual(session);
  });

  test('buildQrContent contains expected params', async () => {
    const { buildQrContent } = await import('~/lib/quark-login');
    const url = buildQrContent('my-token');
    expect(url).toContain('token=my-token');
    expect(url).toContain('client_id=532');
    expect(url).toContain('ssb=weblogin');
  });

  test('CAS_STATUS_OK constant is 2000000', async () => {
    const { CAS_STATUS_OK } = await import('~/lib/quark-login');
    expect(CAS_STATUS_OK).toBe(2000000);
  });

  test('CookieJar stores and retrieves cookies', async () => {
    const { CookieJar } = await import('~/lib/quark-login');
    const jar = new CookieJar();
    jar.absorbPlain('session=xyz; token=abc');
    expect(jar.header()).toContain('session=xyz');
    expect(jar.header()).toContain('token=abc');
  });

  test('CookieJar.isLoginCookie detects login cookies', async () => {
    const { CookieJar } = await import('~/lib/quark-login');
    const jar = new CookieJar();
    jar.absorbPlain('__pus=login_token');
    expect(jar.isLoginCookie()).toBe(true);
  });
});

describe('Baidu QR Login Smoke', () => {
  test('encodeBaiduSession/decodeBaiduSession round-trip', async () => {
    const { encodeBaiduSession, decodeBaiduSession } = await import(
      '~/lib/baidu-login'
    );
    const session = {
      sign: 'abc123',
      gid: 'gid-456',
      baiduid: 'BAIDUID-789',
      created: 1_700_000_000,
    };
    const encoded = encodeBaiduSession(session);
    expect(encoded).toBeTruthy();
    const decoded = decodeBaiduSession(encoded);
    expect(decoded).toEqual(session);
  });

  test('decodeBaiduSession rejects invalid input', async () => {
    const { decodeBaiduSession } = await import('~/lib/baidu-login');
    expect(decodeBaiduSession('')).toBeNull();
    expect(decodeBaiduSession('not-valid-base64!!!')).toBeNull();
  });

  test('generateGid returns hex string of length 32', async () => {
    const { generateGid } = await import('~/lib/baidu-login');
    const gid = generateGid();
    expect(typeof gid).toBe('string');
    expect(gid.length).toBe(32);
    expect(gid).toMatch(/^[0-9a-f]+$/);
  });
});

describe('Alicloud QR Login Smoke', () => {
  test('encodeAlicloudSession/decodeAlicloudSession round-trip', async () => {
    const { encodeAlicloudSession, decodeAlicloudSession } = await import(
      '~/lib/alicloud-login'
    );
    const session = {
      token: 'alipay-token-123',
      clientId: 'cli-456',
      created: 1_700_000_000,
    };
    const encoded = encodeAlicloudSession(session);
    expect(encoded).toBeTruthy();
    const decoded = decodeAlicloudSession(encoded);
    expect(decoded).toEqual(session);
  });

  test('decodeAlicloudSession rejects invalid input', async () => {
    const { decodeAlicloudSession } = await import('~/lib/alicloud-login');
    expect(decodeAlicloudSession('')).toBeNull();
    expect(decodeAlicloudSession('invalid!!!')).toBeNull();
  });
});

describe('API Route Structure Smoke', () => {
  test('api.quark-qr exports action and loader', async () => {
    const mod = await import('../app/routes/api.quark-qr.ts');
    expect(typeof mod.action).toBe('function');
    expect(typeof mod.loader).toBe('function');
  });

  test('api.baidu-qr exports action and loader', async () => {
    const mod = await import('../app/routes/api.baidu-qr.ts');
    expect(typeof mod.action).toBe('function');
    expect(typeof mod.loader).toBe('function');
  });

  test('api.alicloud-qr exports action, loader, and authorize', async () => {
    const mod = await import('../app/routes/api.alicloud-qr.ts');
    expect(typeof mod.action).toBe('function');
    expect(typeof mod.loader).toBe('function');
    expect(typeof mod.authorize).toBe('function');
  });

  test('home route exports loader function', async () => {
    const mod = await import('../app/routes/home.tsx');
    expect(typeof mod.loader).toBe('function');
  });
});

describe('Route Registration Smoke', () => {
  test('all three QR routes are registered in routes.ts', async () => {
    const fs = await import('fs');
    const routesContent = fs.readFileSync('app/routes.ts', 'utf-8');
    expect(routesContent).toContain('api/quark-qr');
    expect(routesContent).toContain('api/baidu-qr');
    expect(routesContent).toContain('api/alicloud-qr');
  });
});

describe('QR Lib Constants Smoke', () => {
  test('Quark QR constants are reasonable', async () => {
    const { QUARK_QR_TTL_SEC, QUARK_QR_POLL_MS } = await import(
      '~/lib/quark-login'
    );
    expect(QUARK_QR_TTL_SEC).toBe(300);
    expect(QUARK_QR_POLL_MS).toBe(3000);
  });

  test('Baidu QR constants are reasonable', async () => {
    const { BAIDU_QR_TTL_SEC, BAIDU_QR_POLL_MS } = await import(
      '~/lib/baidu-login'
    );
    expect(BAIDU_QR_TTL_SEC).toBe(300);
    expect(BAIDU_QR_POLL_MS).toBe(3000);
  });

  test('Alicloud QR constants are reasonable', async () => {
    const { ALICLOUD_QR_TTL_SEC, ALICLOUD_QR_POLL_MS } = await import(
      '~/lib/alicloud-login'
    );
    expect(ALICLOUD_QR_TTL_SEC).toBe(300);
    expect(ALICLOUD_QR_POLL_MS).toBe(3000);
  });
});
