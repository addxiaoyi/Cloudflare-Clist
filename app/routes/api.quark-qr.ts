import { initDatabase } from '~/lib/storage';
import { requireAuth } from '~/lib/auth';
import {
  CAS_CLIENT_ID,
  CAS_STATUS_OK,
  CAS_STATUS_FAIL,
  CookieJar,
  buildQrContent,
  casRequest,
  decodeSession,
  encodeSession,
  queryQrSession,
  requestId,
  CAS_VERSION,
  QUARK_QR_TTL_SEC,
  QUARK_QR_POLL_MS,
} from '~/lib/quark-login';
import type { QueryResult } from '~/lib/quark-login';

const ACTION_SESSION = 'quark_qr_sessions';

export async function action({
  request,
  context,
}: {
  request: Request;
  context: { cloudflare: { env: Env } };
}) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action !== 'start') {
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }

  try {
    const jar = new CookieJar();
    const cas = await casRequest(
      new URLSearchParams({
        client_id: CAS_CLIENT_ID,
        v: CAS_VERSION,
        request_id: requestId(),
      }),
      jar,
    );
    const token = cas?.data?.members?.token || '';
    if (cas.status !== CAS_STATUS_OK || !token) {
      return Response.json(
        { error: cas.message || '获取夸克登录二维码失败' },
        { status: 502 },
      );
    }

    const session = {
      token,
      casCookie: jar.header(),
      created: Math.floor(Date.now() / 1000),
    };
    const ttl = QUARK_QR_TTL_SEC;
    await db
      .prepare(
        `INSERT OR REPLACE INTO ${ACTION_SESSION} (id, payload, expires_at) VALUES (?, ?, ?)`,
      )
      .bind(
        'singleton',
        JSON.stringify(session),
        Math.floor(Date.now() / 1000) + ttl,
      )
      .run();

    return Response.json({
      session: encodeSession(session),
      qrUrl: buildQrContent(token),
      expiresIn: ttl,
      pollIntervalMs: QUARK_QR_POLL_MS,
    });
  } catch (e: any) {
    return Response.json(
      { error: e.message || '发起夸克扫码登录失败' },
      { status: 502 },
    );
  }
}

export async function loader({
  request,
  context,
}: {
  request: Request;
  context: { cloudflare: { env: Env } };
}) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get('action') !== 'query') {
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }

  const { decodeSession, CookieJar } = await import('~/lib/quark-login');
  const clientSession = decodeSession(url.searchParams.get('session') || '');
  if (!clientSession) {
    return Response.json(
      { error: '扫码会话无效，请重新获取二维码' },
      { status: 400 },
    );
  }

  const row = await db
    .prepare(`SELECT payload, expires_at FROM ${ACTION_SESSION} WHERE id = ?`)
    .bind('singleton')
    .first<{ payload: string; expires_at: number }>();
  if (!row) {
    return Response.json(
      { error: '扫码会话已过期，请重新获取二维码' },
      { status: 400 },
    );
  }
  const serverSession = JSON.parse(row.payload) as {
    token: string;
    casCookie: string;
    created: number;
  };
  if (serverSession.token !== clientSession.token) {
    return Response.json(
      { error: '扫码会话无效，请重新获取二维码' },
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > (row.expires_at || 0)) {
    try {
      await db
        .prepare(`DELETE FROM ${ACTION_SESSION} WHERE id = ?`)
        .bind('singleton')
        .run();
    } catch {
      /* 清理失败不影响主流程 */
    }
    return Response.json({
      status: 'expired',
      message: '二维码已过期，请重新获取',
    });
  }

  try {
    const jar = new CookieJar();
    jar.absorbPlain(serverSession.casCookie);
    const result: QueryResult = await queryQrSession(clientSession);
    if (result.status === 'success') {
      try {
        await db
          .prepare(`DELETE FROM ${ACTION_SESSION} WHERE id = ?`)
          .bind('singleton')
          .run();
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
    return Response.json(result);
  } catch (e: any) {
    return Response.json({
      status: 'failed',
      message: e.message || '查询扫码状态失败',
    });
  }
}
