import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function mockCasJsonResponse(
  members: Record<string, unknown> | null,
  setCookieHeader = '',
) {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  if (setCookieHeader) {
    headers.set('set-cookie', setCookieHeader);
  }
  mockFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        status: 2000000,
        data: { members },
      }),
      {
        status: 200,
        headers,
      },
    ),
  );
}

async function mockPanAccountInfoResponse(setCookieHeader = '') {
  const headers = new Headers();
  if (setCookieHeader) {
    headers.set('set-cookie', setCookieHeader);
  }
  mockFetch.mockResolvedValueOnce(
    new Response('', {
      status: 200,
      headers,
    }),
  );
}

async function mockOtherPanResponse() {
  mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
}

describe('queryQrSession behavior - QR scanned but not confirmed', () => {
  test('returns waiting when CAS_STATUS_OK and token changed but no service_ticket (normal "scanned but not confirmed" state)', async () => {
    const { queryQrSession } = await import('~/lib/quark-login');

    await mockCasJsonResponse({ token: 'changed-token' });

    const result = await queryQrSession({
      token: 'original-token',
      casCookie: '',
      created: 1234567890,
    });
    expect(result).toEqual({ status: 'waiting' });
  });

  test('returns failed when CAS_STATUS_FAIL (server error)', async () => {
    const { queryQrSession } = await import('~/lib/quark-login');

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 50004002,
          data: { members: null },
          message: '扫码登录失败',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await queryQrSession({
      token: 'token-123',
      casCookie: '',
      created: 1234567890,
    });
    expect(result).toEqual({ status: 'failed', message: '扫码登录失败' });
  });

  test('returns success when service_ticket present and cookie obtained', async () => {
    const { queryQrSession } = await import('~/lib/quark-login');

    // CAS request: service_ticket present, no cookie yet
    await mockCasJsonResponse(
      { token: 'token-456', service_ticket: 'ticket-abc' },
      '', // no Set-Cookie from CAS
    );
    // PAN account info: sets __pus cookie
    await mockPanAccountInfoResponse('__pus=xyz; Path=/');
    // Other PAN requests (home page, sort) - required by exchangeTicketForCookie
    await mockOtherPanResponse(); // home page
    await mockOtherPanResponse(); // sort endpoint

    const result = await queryQrSession({
      token: 'token-456',
      casCookie: '',
      created: 1234567890,
    });
    expect(result).toEqual({ status: 'success', cookie: '__pus=xyz' });
  });

  test('returns failed when service_ticket present but cookie exchange fails', async () => {
    const { queryQrSession } = await import('~/lib/quark-login');

    // CAS request: service_ticket present, no __pus cookie
    await mockCasJsonResponse(
      { token: 'token-789', service_ticket: 'ticket-xyz' },
      '', // no __pus cookie from CAS
    );
    // PAN account info: no __pus cookie
    await mockPanAccountInfoResponse('');
    // Other PAN requests
    await mockOtherPanResponse(); // home page
    await mockOtherPanResponse(); // sort endpoint

    const result = await queryQrSession({
      token: 'token-789',
      casCookie: '',
      created: 1234567890,
    });
    expect(result).toEqual({
      status: 'failed',
      message: '未获取到有效登录 Cookie',
    });
  });

  test('returns waiting when CAS_STATUS_OK and token unchanged (no scan yet)', async () => {
    const { queryQrSession } = await import('~/lib/quark-login');

    await mockCasJsonResponse({ token: 'token-000' });

    const result = await queryQrSession({
      token: 'token-000',
      casCookie: '',
      created: 1234567890,
    });
    expect(result).toEqual({ status: 'waiting' });
  });
});
