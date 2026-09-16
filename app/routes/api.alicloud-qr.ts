import { initDatabase } from '~/lib/storage';
import { requireAuth } from '~/lib/auth';
import {
  ALICLOUD_QR_TTL_SEC,
  ALICLOUD_QR_POLL_MS,
  encodeAlicloudSession,
  decodeAlicloudSession,
  createAlicloudQrCode,
  checkAlicloudQrStatus,
  exchangeAlicloudCodeForToken,
} from '~/lib/alicloud-login';

const ACTION_SESSION = 'alicloud_qr_sessions';

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

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    client_id?: string;
  };
  if (body.action !== 'start') {
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }

  const clientId = body.client_id || '';
  if (!clientId) {
    return Response.json(
      { error: '缺少 client_id，请在配置中填写客户端ID' },
      { status: 400 },
    );
  }

  try {
    const qrResult = await createAlicloudQrCode(clientId);
    const session = {
      token: qrResult.token,
      clientId,
      created: Math.floor(Date.now() / 1000),
    };
    const ttl = ALICLOUD_QR_TTL_SEC;
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
      session: encodeAlicloudSession(session),
      qrUrl: qrResult.qrCodeUrl,
      expiresIn: ttl,
      pollIntervalMs: ALICLOUD_QR_POLL_MS,
    });
  } catch (e: any) {
    return Response.json(
      { error: e.message || '发起阿里云盘扫码登录失败' },
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

  const clientSession = decodeAlicloudSession(
    url.searchParams.get('session') || '',
  );
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
    clientId: string;
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
    const result = await checkAlicloudQrStatus(serverSession.token);
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

export async function authorize({
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

  const body = (await request.json().catch(() => ({}))) as {
    session?: string;
    client_id?: string;
    client_secret?: string;
  };
  const clientSession = decodeAlicloudSession(body.session || '');
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
    clientId: string;
    created: number;
  };
  if (serverSession.token !== clientSession.token) {
    return Response.json(
      { error: '扫码会话无效，请重新获取二维码' },
      { status: 400 },
    );
  }

  const clientId = body.client_id || serverSession.clientId;
  const clientSecret = body.client_secret || '';
  if (!clientId || !clientSecret) {
    return Response.json(
      { error: '缺少 client_id 或 client_secret，请在配置中填写' },
      { status: 400 },
    );
  }

  try {
    const result = await checkAlicloudQrStatus(serverSession.token);
    if (result.status !== 'success' || !result.code) {
      return Response.json(
        { error: '请先完成扫码确认' },
        { status: 400 },
      );
    }

    const tokenData = await exchangeAlicloudCodeForToken(
      result.code,
      clientId,
      clientSecret,
    );

    await db
      .prepare(`DELETE FROM ${ACTION_SESSION} WHERE id = ?`)
      .bind('singleton')
      .run();

    return Response.json({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
    });
  } catch (e: any) {
    return Response.json({
      error: e.message || '兑换阿里云盘令牌失败',
    });
  }
}
