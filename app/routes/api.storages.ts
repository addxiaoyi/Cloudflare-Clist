import type { Route } from "./+types/api.storages";
import {
  getAllStorages,
  getPublicStorages,
  createStorage,
  updateStorage,
  deleteStorage,
  getStorageById,
  initDatabase,
  exportStoragesForBackup,
  importStoragesFromBackup,
  type BackupData,
  type StorageInput,
} from "~/lib/storage";
import {
  requireAuth,
  createSession,
  deleteSession,
  validateAdmin,
  createSessionCookie,
  deleteSessionCookie,
  getSessionIdFromCookie,
  renewSession,
  shouldRenewSession,
  cleanExpiredSessions,
  SESSION_DEFAULT_HOURS,
  SESSION_REMEMBER_HOURS,
} from "~/lib/auth";
import { getRequestMeta, logAudit } from "~/lib/audit";

// 仅 HTTPS 才给 cookie 加 Secure；http 开发环境加 Secure 会被浏览器拒收
function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

// S3/WebDAV 的 endpoint 必须是非空的有效 URL；缺协议头时自动补 https://
function normalizeEndpoint(type: string, endpoint: unknown): string {
  if (type !== "s3" && type !== "webdev") return "";
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new Error("Endpoint 不能为空，请输入有效的服务器地址");
  }
  const value = endpoint.trim();
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    new URL(withScheme);
  } catch {
    throw new Error("Endpoint 不是有效的 URL 地址");
  }
  return withScheme;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const auth = await requireAuth(request, db);

  // 管理员会话滑动续期：剩余有效期不足一半时顺延，避免“过一段时间就掉线”
  let headers: Record<string, string> = {};
  if (auth.isAdmin && auth.session && shouldRenewSession(auth.session)) {
    await renewSession(db, auth.session.id);
    headers["Set-Cookie"] = createSessionCookie(
      auth.session.id,
      SESSION_DEFAULT_HOURS * 3600,
      isSecureRequest(request)
    );
  }

  if (auth.isAdmin) {
    const storages = await getAllStorages(db);
    return Response.json(
      {
        storages: storages.map((s) => ({
          ...s,
          secretAccessKey: "***",
          saving: {},
        })),
        isAdmin: true,
      },
      { headers }
    );
  }

  const storages = await getPublicStorages(db);
  return Response.json(
    {
      storages: storages.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        isPublic: s.isPublic,
        guestList: s.guestList,
        guestDownload: s.guestDownload,
        guestUpload: s.guestUpload,
      })),
      isAdmin: false,
    },
    { headers }
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);

  const method = request.method;

  if (method === "POST") {
    const body = await request.json();
    const { action: actionType } = body as { action?: string };

    // Login action
    if (actionType === "login") {
      const { username, password, remember } = body as { username: string; password: string; remember?: boolean };
      const isValid = await validateAdmin(username, password, context.cloudflare.env as { ADMIN_USERNAME: string; ADMIN_PASSWORD: string });

      if (!isValid) {
        await logAudit(db, {
          action: "auth.login_failed",
          userType: "guest",
          ip: meta.ip,
          userAgent: meta.userAgent,
          detail: { username },
        });
        return Response.json({ error: "Invalid credentials" }, { status: 401 });
      }

      // “记住我”=30 天，否则 7 天
      const expiresInHours = remember ? SESSION_REMEMBER_HOURS : SESSION_DEFAULT_HOURS;
      const sessionId = await createSession(db, "admin", expiresInHours);
      // 顺手清理过期会话，避免 sessions 表无限膨胀
      await cleanExpiredSessions(db);
      await logAudit(db, {
        action: "auth.login",
        userType: "admin",
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { username, remember: !!remember },
      });
      return Response.json(
        { success: true },
        {
          headers: {
            "Set-Cookie": createSessionCookie(sessionId, expiresInHours * 3600, isSecureRequest(request)),
          },
        }
      );
    }

    // Logout action
    if (actionType === "logout") {
      const cookieHeader = request.headers.get("Cookie");
      const sessionId = getSessionIdFromCookie(cookieHeader);
      if (sessionId) {
        await deleteSession(db, sessionId);
      }
      await logAudit(db, {
        action: "auth.logout",
        userType: "admin",
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return Response.json(
        { success: true },
        {
          headers: {
            "Set-Cookie": deleteSessionCookie(),
          },
        }
      );
    }

    // Export backup (admin only)
    if (actionType === "export-backup") {
      const { isAdmin } = await requireAuth(request, db, "admin");
      if (!isAdmin) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }

      try {
        const backup = await exportStoragesForBackup(db);
        await logAudit(db, {
          action: "backup.export",
          userType: "admin",
          ip: meta.ip,
          userAgent: meta.userAgent,
          detail: { storages: backup.storages?.length || 0 },
        });
        return Response.json({ backup });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to export backup" },
          { status: 500 }
        );
      }
    }

    // Import backup (admin only)
    if (actionType === "import-backup") {
      const { isAdmin } = await requireAuth(request, db, "admin");
      if (!isAdmin) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }

      const { backup, mode } = body as { backup: BackupData; mode: 'merge' | 'replace' };

      if (!backup || !backup.storages || !Array.isArray(backup.storages)) {
        return Response.json({ error: "Invalid backup data" }, { status: 400 });
      }

      if (mode !== 'merge' && mode !== 'replace') {
        return Response.json({ error: "Invalid import mode" }, { status: 400 });
      }

      try {
        const result = await importStoragesFromBackup(db, backup, mode);
        await logAudit(db, {
          action: "backup.import",
          userType: "admin",
          ip: meta.ip,
          userAgent: meta.userAgent,
          detail: { mode, imported: result.imported, skipped: result.skipped },
        });
        return Response.json({ success: true, ...result });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to import backup" },
          { status: 500 }
        );
      }
    }

    // Create storage (admin only)
    const { isAdmin } = await requireAuth(request, db, "admin");
    if (!isAdmin) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    try {
      const input = body as Parameters<typeof createStorage>[1];
      input.endpoint = normalizeEndpoint(input.type || "s3", input.endpoint);
      const storage = await createStorage(db, input);
      const { saving, ...safeStorage } = storage;
      await logAudit(db, {
        action: "storage.create",
        userType: "admin",
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId: storage.id,
        detail: {
          name: storage.name,
          type: storage.type,
          isPublic: storage.isPublic,
          guestList: storage.guestList,
          guestDownload: storage.guestDownload,
          guestUpload: storage.guestUpload,
        },
      });
      return Response.json({ storage: { ...safeStorage, secretAccessKey: "***" } });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create storage" },
        { status: 400 }
      );
    }
  }

  if (method === "PUT") {
    const { isAdmin } = await requireAuth(request, db, "admin");
    if (!isAdmin) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = await request.json();

    try {
      const input = body as { id: number; type?: string; endpoint?: unknown; [key: string]: unknown };
      const { id, ...rest } = input;
      rest.endpoint = normalizeEndpoint(input.type || "s3", input.endpoint);
      const storage = await updateStorage(db, id, rest as Partial<StorageInput>);
      if (!storage) {
        return Response.json({ error: "Storage not found" }, { status: 404 });
      }
      const { saving, ...safeStorage } = storage;
      await logAudit(db, {
        action: "storage.update",
        userType: "admin",
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId: storage.id,
        detail: {
          name: storage.name,
          type: storage.type,
          isPublic: storage.isPublic,
          guestList: storage.guestList,
          guestDownload: storage.guestDownload,
          guestUpload: storage.guestUpload,
        },
      });
      return Response.json({ storage: { ...safeStorage, secretAccessKey: "***" } });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to update storage" },
        { status: 400 }
      );
    }
  }

  if (method === "DELETE") {
    const { isAdmin } = await requireAuth(request, db, "admin");
    if (!isAdmin) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }

    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get("id") || "0", 10);

    if (!id) {
      return Response.json({ error: "Storage ID required" }, { status: 400 });
    }

    // 先确认存在并写审计，再删除。删除后父行消失，
    // 此时再插入指向它的审计记录会触发外键约束失败（500）
    const existing = await getStorageById(db, id);
    if (!existing) {
      return Response.json({ error: "Storage not found" }, { status: 404 });
    }

    await logAudit(db, {
      action: "storage.delete",
      userType: "admin",
      ip: meta.ip,
      userAgent: meta.userAgent,
      storageId: id,
    });
    await deleteStorage(db, id);
    return Response.json({ success: true });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
