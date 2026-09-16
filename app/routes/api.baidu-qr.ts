import { initDatabase } from '~/lib/storage';
import { requireAuth } from '~/lib/auth';
import {
  BAIDU_QR_TTL_SEC,
  BAIDU_QR_POLL_MS,
  encodeBaiduSession,
  decodeBaiduSession,
  getBaiduQrCode,
  checkBaiduQrStatus,
  getBaiduAuthTicket,
  exchangeBaiduTicketForCookies,
} from '~/lib/baidu-login';

const ACTION_SESSION = 'baidu_qr_sessions';

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
    const qrResult = await getBaiduQrCode({});
    const session = {
      sign: qrResult.sign,
      gid: qrResult.gid,
      baiduid: qrResult.baiduid,
      created: Math.floor(Date.now() / 1000),
    };
    const ttl = BAIDU_QR_TTL_SEC;
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
      session: encodeBaiduSession(session),
      qrUrl: `https://${qrResult.imgurl}`,
      expiresIn: ttl,
      pollIntervalMs: BAIDU_QR_POLL_MS,
    });
  } catch (e: any) {
    return Response.json(
      { error: e.message || '发起百度扫码登录失败' },
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

  const clientSession = decodeBaiduSession(url.searchParams.get('session') || '');
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
    sign: string;
    gid: string;
    baiduid: string;
    created: number;
  };
  if (serverSession.sign !== clientSession.sign) {
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
    const result = await checkBaiduQrStatus(
      serverSession.sign,
      serverSession.gid,
      serverSession.baiduid,
    );
    if (result.status === 'success' && result.cookie) {
      try {
        const ticket = await getBaiduAuthTicket(
          serverSession.sign,
          serverSession.gid,
          serverSession.baiduid,
        );
        const cookie = await exchangeBaiduTicketForCookies(
          ticket,
          serverSession.gid,
        );
        await db
          .prepare(`DELETE FROM ${ACTION_SESSION} WHERE id = ?`)
          .bind('singleton')
          .run();
        return Response.json({ status: 'success', cookie });
      } catch (e: any) {
        return Response.json({
          status: 'failed',
          message: e.message || '兑换登录 Cookie 失败',
        });
      }
    }
    if (result.status === 'expired') {
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
