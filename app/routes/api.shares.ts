import type { Route } from "./+types/api.shares";
import { initDatabase, getStorageById } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";
import {
  createShare,
  getShareByToken,
  getShareById,
  getAllShares,
  deleteShare,
  cleanExpiredShares,
  verifySharePassword,
} from "~/lib/shares";
import { getRequestMeta, logAudit, isRateLimited } from "~/lib/audit";

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const shareId = url.searchParams.get("id");

  // Get share by token (public access)
  if (token) {
    try {
      const share = await getShareByToken(db, token);
      if (!share) {
        return Response.json({ error: "分享链接不存在或已过期" }, { status: 404 });
      }

      const storage = await getStorageById(db, share.storageId);
      if (!storage) {
        return Response.json({ error: "存储不存在" }, { status: 404 });
      }

      await logAudit(db, {
        action: "share.view",
        userType: "share",
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId: share.storageId,
        path: share.filePath,
      });

      return Response.json({
        share: {
          id: share.id,
          storageId: share.storageId,
          filePath: share.filePath,
          isDirectory: share.isDirectory,
          shareToken: share.shareToken,
          expiresAt: share.expiresAt,
          createdAt: share.createdAt,
          hasPassword: !!share.passwordHash,
        },
        storage: {
          id: storage.id,
          name: storage.name,
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "获取分享信息失败" },
        { status: 500 }
      );
    }
  }

  // Get all shares (admin only)
  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await cleanExpiredShares(db);
    const shares = await getAllShares(db);
    return Response.json({ shares });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "获取分享列表失败" },
      { status: 500 }
    );
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);
  const method = request.method;

  // 解析请求体（POST）
  let body: Record<string, any> = {};
  if (method === "POST") {
    body = (await request.json().catch(() => ({}))) as Record<string, any>;
  }

  // 公开接口：访客验证分享访问密码（无需登录）
  if (method === "POST" && body.action === "verify") {
    const token = body.token as string | undefined;
    const password = body.password as string | undefined;
    if (!token) {
      return Response.json({ error: "token 为必填项" }, { status: 400 });
    }
    // 防爆破：同一 IP 15 分钟内密码失败达 10 次则暂时拒绝
    if (await isRateLimited(db, meta.ip, "share.password_failed")) {
      return Response.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
    }
    const share = await getShareByToken(db, token);
    if (!share) {
      return Response.json({ error: "分享不存在或已过期" }, { status: 404 });
    }
    const ok = await verifySharePassword(db, token, password);
    if (!ok) {
      await logAudit(db, {
        action: "share.password_failed",
        userType: "share",
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId: share.storageId,
        path: share.filePath,
      });
      return Response.json({ success: false });
    }
    return Response.json({ success: true });
  }

  // 其余操作需要管理员
  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (method === "POST") {
    try {
      const { storageId, filePath, isDirectory, expiresAt, shareToken, password } = body as {
        storageId: number;
        filePath: string;
        isDirectory: boolean;
        expiresAt?: string;
        shareToken?: string;
        password?: string;
      };

      if (!storageId || !filePath || isDirectory === undefined) {
        return Response.json(
          { error: "storageId、filePath 和 isDirectory 为必填项" },
          { status: 400 }
        );
      }

      const storage = await getStorageById(db, storageId);
      if (!storage) {
        return Response.json({ error: "存储不存在" }, { status: 404 });
      }

      const share = await createShare(db, storageId, filePath, isDirectory, expiresAt, shareToken, password);

      // Generate share URL
      const baseUrl = new URL(request.url).origin;
      const shareUrl = `${baseUrl}/share?token=${share.shareToken}`;

      await logAudit(db, {
        action: "share.create",
        userType: "admin",
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path: filePath,
        detail: { isDirectory, expiresAt: expiresAt || null, customShareToken: Boolean(shareToken?.trim()), hasPassword: Boolean(password && password.trim()) },
      });

      return Response.json({
        success: true,
        share,
        shareUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建分享链接失败";
      const status = message.includes("已存在") ? 409 : message.includes("分享令牌只能") ? 400 : 500;
      return Response.json(
        { error: message },
        { status }
      );
    }
  }

  if (method === "DELETE") {
    try {
      const url = new URL(request.url);
      const shareId = url.searchParams.get("id");

      if (!shareId) {
        return Response.json({ error: "id 为必填项" }, { status: 400 });
      }

      const share = await getShareById(db, shareId);
      if (!share) {
        return Response.json({ error: "分享链接不存在" }, { status: 404 });
      }

      await deleteShare(db, shareId);

      await logAudit(db, {
        action: "share.delete",
        userType: "admin",
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId: share.storageId,
        path: share.filePath,
      });

      return Response.json({ success: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "删除分享链接失败" },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
