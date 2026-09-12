import type { Route } from "./+types/api.storages";
import {
  getAllStorages,
  getPublicStorages,
  createStorage,
  updateStorage,
  deleteStorage,
  getStorageById,
  initDatabase,
  autoMountR2,
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
import { getRequestMeta, logAudit, isRateLimited } from "~/lib/audit";
import { createClient, createMysqlClient } from "~/lib/client-factory";

// 仅 HTTPS 才给 cookie 加 Secure；http 开发环境加 Secure 会被浏览器拒收
function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

// 下发给浏览器的存储对象需脱敏：config 里的 OAuth 客户端密钥/令牌/会话 Cookie 不给前端
const SENSITIVE_CONFIG_KEYS = new Set([
  "client_secret",
  "refresh_token",
  "access_token",
  "cloudflare_access_token",
  "cloudflare_refresh_token",
  "cookie",
  "bduss",
  "stoken",
  // qiniu/tigris 等把 S3 密钥放在 config
  "access_key_id",
  "secret_access_key",
  "access_key",
  "secret_key",
]);

function sanitizeStorageForClient<T extends { config?: Record<string, any> }>(storage: T): T {
  if (!storage.config) return storage;
  const config = { ...storage.config };
  for (const key of Object.keys(config)) {
    if (SENSITIVE_CONFIG_KEYS.has(key)) {
      config[key] = "***";
    }
  }
  return { ...storage, config };
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
  // 部署了 R2 绑定则自动挂载，管理员打开管理页即可看到
  await autoMountR2(db, context.cloudflare.env);

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
        storages: storages.map((s) =>
          sanitizeStorageForClient({
            ...s,
            secretAccessKey: "***",
            saving: {},
          })
        ),
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

      // 防爆破：同一 IP 15 分钟内失败达 10 次则暂时拒绝
      if (await isRateLimited(db, meta.ip, "auth.login_failed")) {
        return Response.json(
          { error: "登录尝试过于频繁，请稍后再试" },
          { status: 429 }
        );
      }

      const isValid = await validateAdmin(username, password, context.cloudflare.env as { ADMIN_USERNAME: string; ADMIN_PASSWORD: string });

      if (!isValid) {
        await logAudit(db, {
          action: "auth.login_failed",
          userType: "guest",
          ip: meta.ip,
          userAgent: meta.userAgent,
          detail: { username },
        });
        const adminUser = (context.cloudflare.env as unknown as Record<string, string | undefined>).ADMIN_USERNAME;
        const hasAdminVar =
          adminUser !== undefined && adminUser !== null && adminUser !== "";
        return Response.json(
          {
            error: "Invalid credentials",
            hint: hasAdminVar
              ? `请检查用户名与密码；若在 Cloudflare 控制台配置过 ADMIN_USERNAME / ADMIN_PASSWORD Secret，Secret 会覆盖 wrangler.jsonc 中的值，请使用 Secret 中的凭据或在控制台删除 Secret 后使用默认值 admin / changeme。`
              : "管理员账号未配置，请在 Cloudflare 控制台 Settings → Variables and Secrets 中添加 ADMIN_USERNAME 与 ADMIN_PASSWORD。",
          },
          { status: 401 }
        );
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

    // 保存前连通性测试（管理员）：用草稿配置建客户端并列表根目录
    if (actionType === "test-connection") {
      const { isAdmin } = await requireAuth(request, db, "admin");
      if (!isAdmin) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }
      try {
        const cfg = body as Record<string, any>;
        const type = String(cfg.type || "s3");
        const storageLike = {
          type,
          endpoint: normalizeEndpoint(type, cfg.endpoint),
          region: String(cfg.region || "auto"),
          accessKeyId: String(cfg.accessKeyId || ""),
          secretAccessKey: String(cfg.secretAccessKey || ""),
          bucket: String(cfg.bucket || ""),
          basePath: String(cfg.basePath || ""),
          config: (cfg.config || {}) as Record<string, any>,
          saving: (cfg.saving || {}) as Record<string, any>,
        };
        const startedAt = Date.now();
        let client;
        try {
          if (type === "mysql") {
            // MySQL 走 Hyperdrive / 直连串，与文件存储客户端不同
            const mysql = createMysqlClient(storageLike, context.cloudflare.env);
            await mysql.listDatabases();
            return Response.json({ ok: true, latencyMs: Date.now() - startedAt, items: 0 });
          }
          client = createClient(storageLike, context.cloudflare.env, Number(cfg.storageId || 0));
        } catch (error) {
          return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : "配置无效",
          });
        }
        const result = await client.listObjects("", "/", 1);
        return Response.json({
          ok: true,
          latencyMs: Date.now() - startedAt,
          items: (result.objects || []).length + (result.prefixes || []).length,
        });
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : "连接测试失败" },
          { status: 200 }
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
      return Response.json({ storage: sanitizeStorageForClient({ ...safeStorage, secretAccessKey: "***" }) });
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
      return Response.json({ storage: sanitizeStorageForClient({ ...safeStorage, secretAccessKey: "***" }) });
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
