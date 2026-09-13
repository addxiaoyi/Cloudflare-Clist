import type { Route } from "./+types/api.files.$storageId.$";
import { getStorageById, initDatabase, updateStorage } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";
import { getShareByToken, verifySharePassword } from "~/lib/shares";
import { createClient, type StorageClient, type ClientEnv } from "~/lib/client-factory";
import { getRequestMeta, logAudit, isRateLimited } from "~/lib/audit";
import { getFileType, getMimeType, fileResponseHeaders, isUnsafeInlineType, makeRangeResponseHeaders } from "~/lib/file-utils";

// ---------------------------------------------------------------------------
// 安全守卫
// ---------------------------------------------------------------------------

// 路径穿越防护：拒绝包含 ".." 段、空段路径或控制字符的路径
function assertSafePath(path: string): void {
  if (!path) return;
  if (/[\u0000-\u001f]/.test(path)) {
    throw new Error("路径包含非法控制字符");
  }
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error("路径不能包含 .. 或 . 段");
  }
}

// 内网/回环/链路本地/保留地址段（含 IPv6），用于防 SSRF
const PRIVATE_IP_RE =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::ffff:127\.|fc|fd)/i;

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.endsWith(".internal") || lower.endsWith(".local")) return true;
  // IPv6 去掉作用域
  const addr = lower.replace(/^\[|\]$/g, "").split("%")[0];
  return PRIVATE_IP_RE.test(addr);
}

// 校验离线下载 URL：仅允许 http/https，且不能指向内网/回环地址
function assertSafeFetchUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 协议的下载链接");
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("不允许下载内网或本地地址");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 公开下载限流：guest/share 按 IP 统计 60s 内的请求数与累计字节数，超限拒绝，
// 防脚本高频拉取/大文件风暴造成 Worker 带宽与费用滥用。admin 不受限。
// ---------------------------------------------------------------------------
const DOWNLOAD_WINDOW_MS = 60_000;
const DOWNLOAD_MAX_REQUESTS = 90;
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024; // 1GB / 分钟 / IP
const downloadTrack = new Map<string, { times: number[]; bytes: number }>();

function allowPublicDownload(ip: string | null, contentLength: number): boolean {
  const key = ip || "unknown";
  const now = Date.now();
  const cur = downloadTrack.get(key);
  if (!cur) {
    downloadTrack.set(key, { times: [now], bytes: contentLength });
    return contentLength <= DOWNLOAD_MAX_BYTES;
  }
  const times = cur.times.filter((t) => now - t < DOWNLOAD_WINDOW_MS);
  if (times.length >= DOWNLOAD_MAX_REQUESTS || cur.bytes + contentLength > DOWNLOAD_MAX_BYTES) {
    downloadTrack.set(key, { times, bytes: cur.bytes });
    return false;
  }
  times.push(now);
  downloadTrack.set(key, { times, bytes: cur.bytes + contentLength });
  return true;
}


type StatefulClient = {
  getStateUpdates: () => { config?: Record<string, any>; saving?: Record<string, any> } | null;
};

async function persistClientState(
  client: StorageClient,
  db: D1Database,
  storageId: number
): Promise<void> {
  const stateful = client as unknown as StatefulClient;
  if (typeof stateful.getStateUpdates !== "function") {
    return;
  }
  const updates = stateful.getStateUpdates();
  if (!updates) {
    return;
  }
  const input: { config?: Record<string, any>; saving?: Record<string, any> } = {};
  if (updates.config) {
    input.config = updates.config;
  }
  if (updates.saving) {
    input.saving = updates.saving;
  }
  if (Object.keys(input).length === 0) {
    return;
  }
  await updateStorage(db, storageId, input);
}

async function withClientState<T>(
  client: StorageClient,
  db: D1Database,
  storageId: number,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } finally {
    try {
      await persistClientState(client, db, storageId);
    } catch (error) {
      console.error("Failed to persist storage state:", error);
    }
  }
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);

  const storageId = parseInt(params.storageId || "0", 10);
  const path = params["*"] || "";

  try {
    assertSafePath(path);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "非法路径" },
      { status: 400 }
    );
  }

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return Response.json({ error: "Storage not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const shareToken = url.searchParams.get("token");
  const isInlineImageRequest = !action && path && getFileType(path) === "image";

  let isAdmin = false;
  let shareVerified = false;
  let userType: "admin" | "guest" | "share" = "guest";

  if (shareToken) {
    const share = await getShareByToken(db, shareToken);
    if (share && share.storageId === storageId) {
      // 规范化：去掉尾部斜杠，避免 "photos/" + "/" = "photos//" 导致子路径匹配失败
      const sharePath = (share.filePath || "").replace(/\/+$/, "");
      const sharePathPrefix = sharePath ? sharePath + "/" : "";
      if (path === sharePath || path === sharePath + "/" || path.startsWith(sharePathPrefix)) {
        shareVerified = true;
      }
      // 若分享设了访问密码，必须校验通过
      if (shareVerified && share.passwordHash) {
        // 防爆破：同一 IP 15 分钟内密码失败达 10 次则暂时拒绝
        if (await isRateLimited(db, meta.ip, "share.password_failed")) {
          return Response.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
        }
        const password = url.searchParams.get("password") || undefined;
        const ok = await verifySharePassword(db, shareToken, password);
        if (!ok) {
          await logAudit(db, {
            action: "share.password_failed",
            userType: "share",
            ip: meta.ip,
            userAgent: meta.userAgent,
            storageId: share.storageId,
            path: share.filePath,
          });
          return Response.json({ error: "需要访问密码或密码错误" }, { status: 403 });
        }
      }
    }
    if (!shareVerified) {
      return Response.json({ error: "分享令牌无效或已过期" }, { status: 403 });
    }
    userType = "share";
  } else {
    const authResult = await requireAuth(request, db);
    isAdmin = authResult.isAdmin;
    userType = isAdmin ? "admin" : "guest";
  }

  // Permission checks based on action
  const canList = isAdmin || shareVerified || storage.guestList;
  const canDownload = isAdmin || shareVerified || storage.guestDownload;

  // List objects - requires list permission
  if (action === "list" || (!action && !isInlineImageRequest)) {
    if (!canList) {
      return Response.json({ error: "没有浏览权限" }, { status: 403 });
    }
  } else {
    // Download, signed-url, info - requires download permission
    if (!canDownload) {
      return Response.json({ error: "没有下载权限" }, { status: 403 });
    }
  }

  // 配置无效时 createClient 会抛错（如 endpoint 为空），转成 JSON 错误而非 500 页面
  let client;
  try {
    client = createClient(storage, context.cloudflare.env, storageId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "存储配置无效，请检查后重试" },
      { status: 400 }
    );
  }

  // List objects
  if (action === "list" || (!action && !isInlineImageRequest)) {
    try {
      const result = await withClientState(client, db, storageId, () => client.listObjects(path));
      return Response.json({
        storage: { id: storage.id, name: storage.name },
        path,
        ...result,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to list objects" },
        { status: 500 }
      );
    }
  }

  // Inline image preview via direct file URL, e.g. /api/files/7/images/1.jpg
  if (isInlineImageRequest) {
    try {
      const rangeHeader = request.headers.get("range") || undefined;
      const response = await withClientState(client, db, storageId, () => client.getObject(path, rangeHeader ? { range: rangeHeader } : undefined));
      const upstreamContentType = response.headers.get("content-type") || "";
      const contentType = upstreamContentType.startsWith("image/")
        ? upstreamContentType
        : getMimeType(path);
      const contentLength = response.headers.get("content-length");
      const fileName = path.split("/").pop() || "image";

      // 公开下载限流：guest/share 按 IP 限速（admin 不限）
      if (userType !== "admin" && !allowPublicDownload(meta.ip, Number(contentLength) || 0)) {
        return Response.json({ error: "下载过于频繁，请稍后再试" }, { status: 429 });
      }

      await logAudit(db, {
        action: "file.preview",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { fileName, contentLength, contentType },
      });

      // 危险类型（HTML/SVG/XML/JS/CSS）即使走图片直链也强制附件下载，防同源脚本执行
      const unsafeInline = isUnsafeInlineType(contentType);
      const disposition = unsafeInline ? "attachment" : "inline";

      const status = response.status;
      const rangeHeaders = makeRangeResponseHeaders(response.headers);

      return new Response(response.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `${disposition}; filename="${encodeURIComponent(fileName)}"`,
          ...fileResponseHeaders(contentType, !unsafeInline),
          ...(contentLength ? { "Content-Length": contentLength } : {}),
          ...rangeHeaders,
        },
        status,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to preview image" },
        { status: 500 }
      );
    }
  }

  // Download file
  if (action === "download") {
    try {
      const rangeHeader = request.headers.get("range") || undefined;
      const response = await withClientState(client, db, storageId, () => client.getObject(path, rangeHeader ? { range: rangeHeader } : undefined));
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const contentLength = response.headers.get("content-length");

      const fileName = path.split("/").pop() || "download";

      // 公开下载限流：guest/share 按 IP 限速（admin 不限）
      if (userType !== "admin" && !allowPublicDownload(meta.ip, Number(contentLength) || 0)) {
        return Response.json({ error: "下载过于频繁，请稍后再试" }, { status: 429 });
      }

      await logAudit(db, {
        action: "file.download",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { fileName, contentLength },
      });

      const wantsInline = url.searchParams.get("inline") === "1";
      // 危险类型即使请求 inline 也强制附件下载
      const inline = wantsInline && !isUnsafeInlineType(contentType);

      const status = response.status;
      const rangeHeaders = makeRangeResponseHeaders(response.headers);

      return new Response(response.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(fileName)}"`,
          ...fileResponseHeaders(contentType, inline),
          ...(contentLength ? { "Content-Length": contentLength } : {}),
          ...rangeHeaders,
        },
        status,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to download file" },
        { status: 500 }
      );
    }
  }

  // Get signed URL
  if (action === "signed-url") {
    try {
      // 与公开下载共用限流预算，防批量生成直链绕过 Worker 带宽限制（guest/share）
      if (userType !== "admin" && !allowPublicDownload(meta.ip, 0)) {
        return Response.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
      }
      const signedUrl = await withClientState(client, db, storageId, () => client.getSignedUrl(path));
      await logAudit(db, {
        action: "file.signed_url",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
      });
      return Response.json({ url: signedUrl });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to generate signed URL" },
        { status: 500 }
      );
    }
  }

  // Get file info (HEAD)
  if (action === "info") {
    try {
      const info = await withClientState(client, db, storageId, () => client.headObject(path));
      if (!info) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      return Response.json(info);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to get file info" },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);

  const storageId = parseInt(params.storageId || "0", 10);
  const path = params["*"] || "";

  try {
    assertSafePath(path);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "非法路径" },
      { status: 400 }
    );
  }

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return Response.json({ error: "Storage not found" }, { status: 404 });
  }

  const { isAdmin } = await requireAuth(request, db);
  const userType = isAdmin ? "admin" : "guest";

  const method = request.method;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Permission check: upload operations can be done by guests with guestUpload permission
  const canUpload = isAdmin || storage.guestUpload;
  const uploadActions = ["multipart-init", "multipart-urls", "multipart-upload", "multipart-complete", "multipart-abort"];
  const isUploadAction = uploadActions.includes(action || "") || (method === "PUT" && !action) || (method === "POST" && !action);

  if (isUploadAction) {
    if (!canUpload) {
      return Response.json({ error: "没有上传权限" }, { status: 403 });
    }
  } else {
    // All other actions (mkdir, rename, move, delete, fetch) require admin
    if (!isAdmin) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }
  }

  const client = createClient(storage, context.cloudflare.env, storageId);

  // Initialize multipart upload
  if (method === "POST" && action === "multipart-init") {
    try {
      const body = await request.json() as { contentType?: string; size?: number; chunkSize?: number };
      const contentType = body.contentType || "application/octet-stream";
      const isGitHub = storage.type === "github";
      if (isGitHub) {
        return Response.json({ error: "GitHub 存储不支持分片上传（单文件最大 100MB）" }, { status: 400 });
      }
      // 参数上限校验，防存储/CPU 滥用：单文件 ≤ 50GB，分片 1MB-5GB（S3 限制 5MB-5GB，放宽下限兼容小分片）
      const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024;
      const MIN_CHUNK_SIZE = 1 * 1024 * 1024;
      const MAX_CHUNK_SIZE = 5 * 1024 * 1024 * 1024;
      if (body.size !== undefined && (body.size <= 0 || body.size > MAX_FILE_SIZE)) {
        return Response.json({ error: "文件大小超出允许范围（最大 50GB）" }, { status: 400 });
      }
      if (body.chunkSize !== undefined && (body.chunkSize < MIN_CHUNK_SIZE || body.chunkSize > MAX_CHUNK_SIZE)) {
        return Response.json({ error: "分片大小需在 1MB-5GB 之间" }, { status: 400 });
      }
      const uploadId = await withClientState(
        client,
        db,
        storageId,
        () => client.initiateMultipartUpload(path, contentType, { size: body.size, chunkSize: body.chunkSize })
      );
      await logAudit(db, {
        action: "file.multipart_init",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { uploadId, contentType },
      });
      return Response.json({ uploadId });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to initialize multipart upload" },
        { status: 500 }
      );
    }
  }

  // Get signed URLs for multipart upload parts (batch)
  if (method === "POST" && action === "multipart-urls") {
    try {
      const body = await request.json() as {
        uploadId?: string;
        partNumbers?: number[];
      };

      if (!body.uploadId || !body.partNumbers || body.partNumbers.length === 0) {
        return Response.json({ error: "uploadId and partNumbers are required" }, { status: 400 });
      }
      // 分片号去重并限制数量/范围，防一次请求生成海量签名 URL 耗尽 CPU
      const partNumbers = Array.from(new Set(body.partNumbers))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10000);
      if (partNumbers.length === 0) {
        return Response.json({ error: "分片号必须为 1-10000 的整数" }, { status: 400 });
      }
      if (partNumbers.length > 2000) {
        return Response.json({ error: "单次最多请求 2000 个分片签名" }, { status: 400 });
      }
      const uploadId = body.uploadId;

      const urls = await withClientState(client, db, storageId, async () => {
        const result: Record<number, string> = {};
        for (const partNumber of partNumbers) {
          try {
            result[partNumber] = await client.getSignedUploadPartUrl(path, uploadId, partNumber);
          } catch {
            // ignore and fallback to proxy upload
          }
        }
        return result;
      });

      return Response.json({ urls });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to generate signed URLs" },
        { status: 500 }
      );
    }
  }

  // Upload part (streaming) - kept as fallback
  if (method === "PUT" && action === "multipart-upload") {
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = parseInt(url.searchParams.get("partNumber") || "0", 10);

    if (!uploadId || partNumber < 1) {
      return Response.json({ error: "uploadId and partNumber are required" }, { status: 400 });
    }

    if (!request.body) {
      return Response.json({ error: "No part body provided" }, { status: 400 });
    }

    try {
      const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
      const etag = await withClientState(
        client,
        db,
        storageId,
        () => client.uploadPart(path, uploadId, partNumber, request.body as ReadableStream, contentLength)
      );
      return Response.json({ etag, partNumber });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to upload part" },
        { status: 500 }
      );
    }
  }

  // Complete multipart upload
  if (method === "POST" && action === "multipart-complete") {
    try {
      const body = await request.json() as {
        uploadId?: string;
        parts?: { partNumber: number; etag: string }[];
      };

      if (!body.uploadId || !body.parts || body.parts.length === 0) {
        return Response.json({ error: "uploadId and parts are required" }, { status: 400 });
      }
      const uploadId = body.uploadId;
      const parts = body.parts;

      await withClientState(
        client,
        db,
        storageId,
        () => client.completeMultipartUpload(path, uploadId, parts)
      );
      await logAudit(db, {
        action: "file.multipart_complete",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { uploadId, parts: parts.length },
      });
      return Response.json({ success: true, path });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to complete multipart upload" },
        { status: 500 }
      );
    }
  }

  // Abort multipart upload
  if (method === "POST" && action === "multipart-abort") {
    try {
      const body = await request.json() as { uploadId?: string };

      if (!body.uploadId) {
        return Response.json({ error: "uploadId is required" }, { status: 400 });
      }
      const uploadId = body.uploadId;

      await withClientState(
        client,
        db,
        storageId,
        () => client.abortMultipartUpload(path, uploadId)
      );
      await logAudit(db, {
        action: "file.multipart_abort",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { uploadId },
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to abort multipart upload" },
        { status: 500 }
      );
    }
  }

  // Create folder
  if (method === "POST" && action === "mkdir") {
    try {
      await withClientState(client, db, storageId, () => client.createFolder(path));
      await logAudit(db, {
        action: "file.mkdir",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
      });
      return Response.json({ success: true, path });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create folder" },
        { status: 500 }
      );
    }
  }

  // Rename file or folder
  if (method === "POST" && action === "rename") {
    try {
      const body = await request.json() as { newName?: string };
      const { newName } = body;

      if (!newName || newName.includes("/")) {
        return Response.json({ error: "Invalid new name" }, { status: 400 });
      }

      const isDirectory = path.endsWith("/");
      const cleanPath = path.replace(/\/$/, "");
      const parentPath = cleanPath.includes("/")
        ? cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1)
        : "";
      const newPath = parentPath + newName + (isDirectory ? "/" : "");

      const canDirectRename = typeof (client as { renameObject?: (path: string, name: string) => Promise<void> }).renameObject === "function";
      if (canDirectRename) {
        await withClientState(
          client,
          db,
          storageId,
          () => (client as { renameObject: (path: string, name: string) => Promise<void> }).renameObject(path, newName)
        );
        await logAudit(db, {
          action: "file.rename",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory },
        });
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory },
        });
        return Response.json({ success: true, newPath });
      }

      if (isDirectory) {
        // Rename folder: copy all objects with new prefix, then delete old ones
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "", 1000, continuationToken)
            );
            for (const obj of result.objects) {
              keys.push(obj.key);
            }
            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const oldPrefix = cleanPath + "/";
        const newPrefix = parentPath + newName + "/";
        const keysToMove = await listAll(oldPrefix);

        // Copy all objects to new location
        for (const key of keysToMove) {
          const newKey = newPrefix + key.substring(oldPrefix.length);
          await withClientState(client, db, storageId, () => client.copyObject(key, newKey));
        }

        // Delete old objects
        for (const key of keysToMove) {
          await withClientState(client, db, storageId, () => client.deleteObject(key));
        }

        // Try to delete the old folder object
        try {
          await withClientState(client, db, storageId, () => client.deleteObject(oldPrefix));
        } catch {
          // Ignore if not exists
        }

        await logAudit(db, {
          action: "file.rename",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, moved: keysToMove.length, isDirectory: true },
        });
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, moved: keysToMove.length, isDirectory: true },
        });
        return Response.json({ success: true, newPath: newPrefix, moved: keysToMove.length });
      } else {
        // Rename single file
        await withClientState(client, db, storageId, () => client.copyObject(path, newPath));
        await withClientState(client, db, storageId, () => client.deleteObject(path));
        await logAudit(db, {
          action: "file.rename",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        return Response.json({ success: true, newPath });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to rename" },
        { status: 500 }
      );
    }
  }

  // Move file or folder
  if (method === "POST" && action === "move") {
    try {
      const body = await request.json() as { destPath?: string };
      const { destPath } = body;

      if (destPath === undefined) {
        return Response.json({ error: "destPath is required" }, { status: 400 });
      }

      const isDirectory = path.endsWith("/");
      const cleanPath = path.replace(/\/$/, "");
      const fileName = cleanPath.includes("/")
        ? cleanPath.substring(cleanPath.lastIndexOf("/") + 1)
        : cleanPath;

      // destPath is the target directory, fileName is preserved
      const targetDir = destPath.endsWith("/") ? destPath : (destPath ? destPath + "/" : "");
      const newPath = targetDir + fileName + (isDirectory ? "/" : "");

      const canDirectMove = typeof (client as { moveObject?: (path: string, destPath: string) => Promise<void> }).moveObject === "function";
      if (canDirectMove) {
        await withClientState(
          client,
          db,
          storageId,
          () => (client as { moveObject: (path: string, destPath: string) => Promise<void> }).moveObject(path, newPath)
        );
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory },
        });
        return Response.json({ success: true, newPath });
      }

      if (isDirectory) {
        // Move folder: copy all objects with new prefix, then delete old ones
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "", 1000, continuationToken)
            );
            for (const obj of result.objects) {
              keys.push(obj.key);
            }
            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const oldPrefix = cleanPath + "/";
        const newPrefix = targetDir + fileName + "/";
        const keysToMove = await listAll(oldPrefix);

        // Copy all objects to new location
        for (const key of keysToMove) {
          const newKey = newPrefix + key.substring(oldPrefix.length);
          await withClientState(client, db, storageId, () => client.copyObject(key, newKey));
        }

        // Delete old objects
        for (const key of keysToMove) {
          await withClientState(client, db, storageId, () => client.deleteObject(key));
        }

        // Try to delete the old folder object
        try {
          await withClientState(client, db, storageId, () => client.deleteObject(oldPrefix));
        } catch {
          // Ignore if not exists
        }

        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, moved: keysToMove.length, isDirectory: true },
        });
        return Response.json({ success: true, newPath: newPrefix, moved: keysToMove.length });
      } else {
        // Move single file
        await withClientState(client, db, storageId, () => client.copyObject(path, newPath));
        await withClientState(client, db, storageId, () => client.deleteObject(path));
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        return Response.json({ success: true, newPath });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to move" },
        { status: 500 }
      );
    }
  }

  // Copy file or folder (keep source)
  if (method === "POST" && action === "copy") {
    try {
      const body = await request.json() as { destPath?: string };
      const { destPath } = body;

      if (destPath === undefined) {
        return Response.json({ error: "destPath is required" }, { status: 400 });
      }

      const isDirectory = path.endsWith("/");
      const cleanPath = path.replace(/\/$/, "");
      const fileName = cleanPath.includes("/")
        ? cleanPath.substring(cleanPath.lastIndexOf("/") + 1)
        : cleanPath;

      // destPath is the target directory, fileName is preserved
      const targetDir = destPath.endsWith("/") ? destPath : (destPath ? destPath + "/" : "");
      const newPath = targetDir + fileName + (isDirectory ? "/" : "");

      const canDirectCopy = typeof (client as { copyObject?: (src: string, dest: string) => Promise<void> }).copyObject === "function";
      if (isDirectory) {
        // Copy folder: list all objects under prefix, copy to new prefix
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "", 1000, continuationToken)
            );
            for (const obj of result.objects) {
              keys.push(obj.key);
            }
            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const oldPrefix = cleanPath + "/";
        const newPrefix = targetDir + fileName + "/";
        const keysToCopy = await listAll(oldPrefix);

        for (const key of keysToCopy) {
          const newKey = newPrefix + key.substring(oldPrefix.length);
          await withClientState(client, db, storageId, () => client.copyObject(key, newKey));
        }

        await logAudit(db, {
          action: "file.copy",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, copied: keysToCopy.length, isDirectory: true },
        });
        return Response.json({ success: true, newPath: newPrefix, copied: keysToCopy.length });
      } else {
        if (!canDirectCopy) {
          return Response.json({ error: "该存储不支持复制操作" }, { status: 400 });
        }
        await withClientState(client, db, storageId, () => client.copyObject(path, newPath));
        await logAudit(db, {
          action: "file.copy",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        return Response.json({ success: true, newPath });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to copy" },
        { status: 500 }
      );
    }
  }

  // Offline download from URL
  if (method === "POST" && action === "fetch") {
    try {
      const body = await request.json() as { url?: string; filename?: string };
      const { url: remoteUrl, filename } = body;

      if (!remoteUrl) {
        return Response.json({ error: "URL is required" }, { status: 400 });
      }

      // 防 SSRF：仅 http/https，且禁止内网/回环/链路本地地址
      let parsedUrl: URL;
      try {
        parsedUrl = assertSafeFetchUrl(remoteUrl);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Invalid URL" },
          { status: 400 }
        );
      }

      // 手动跟随重定向并逐跳校验，防止公网 URL 302 跳转到内网/云元数据（SSRF 重定向绕过）
      const MAX_REDIRECTS = 5;
      const MAX_DOWNLOAD_SIZE = 200 * 1024 * 1024; // 200MB，防超大文件拖垮 Workers 内存
      const controller = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(60_000)
        : undefined;
      let currentUrl = parsedUrl;
      let remoteResponse: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const hopRes = await fetch(currentUrl.href, {
          redirect: "manual",
          signal: controller,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible)",
          },
        });
        if (hopRes.status >= 300 && hopRes.status < 400) {
          const location = hopRes.headers.get("location");
          if (!location) {
            return Response.json({ error: "重定向缺少 Location 头" }, { status: 400 });
          }
          // 相对地址按当前 URL 解析后再校验
          const next = new URL(location, currentUrl.href);
          try {
            currentUrl = assertSafeFetchUrl(next.href);
          } catch {
            return Response.json({ error: "不允许跳转到内网或本地地址" }, { status: 400 });
          }
          continue;
        }
        remoteResponse = hopRes;
        break;
      }
      if (!remoteResponse) {
        return Response.json({ error: "重定向次数过多" }, { status: 400 });
      }
      if (!remoteResponse.ok) {
        return Response.json(
          { error: `Failed to fetch: ${remoteResponse.status} ${remoteResponse.statusText}` },
          { status: 400 }
        );
      }

      // Content-Length 超限直接拒绝，未提供长度时按字节流读取并中断
      const declaredLength = Number(remoteResponse.headers.get("content-length") || "0");
      if (declaredLength > MAX_DOWNLOAD_SIZE) {
        return Response.json({ error: "文件过大，超出下载上限" }, { status: 413 });
      }
      const reader = remoteResponse.body?.getReader();
      if (!reader) {
        return Response.json({ error: "无法读取远程内容" }, { status: 400 });
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_SIZE) {
          await reader.cancel().catch(() => {});
          return Response.json({ error: "文件过大，超出下载上限" }, { status: 413 });
        }
        chunks.push(value);
      }
      const bodyBuffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bodyBuffer.set(chunk, offset);
        offset += chunk.byteLength;
      }

      // Get filename from URL or Content-Disposition header or use provided filename
      let finalFilename = filename;
      if (!finalFilename) {
        const contentDisposition = remoteResponse.headers.get("content-disposition");
        if (contentDisposition) {
          const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          if (match) {
            finalFilename = match[1].replace(/['"]/g, "");
          }
        }
        if (!finalFilename) {
          finalFilename = parsedUrl.pathname.split("/").pop() || "download";
        }
      }

      // Get content type
      const contentType = remoteResponse.headers.get("content-type") || "application/octet-stream";

      // Upload to S3
      const uploadPath = path ? `${path}/${finalFilename}` : finalFilename;
      await withClientState(client, db, storageId, () => client.putObject(uploadPath, bodyBuffer.buffer as ArrayBuffer, contentType));
      await logAudit(db, {
        action: "file.fetch",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path: uploadPath,
        detail: { sourceUrl: remoteUrl, size: bodyBuffer.byteLength },
      });

      return Response.json({
        success: true,
        path: uploadPath,
        filename: finalFilename,
        size: bodyBuffer.byteLength,
        contentType,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to fetch and upload file" },
        { status: 500 }
      );
    }
  }

  // Upload file
  if (method === "POST" || method === "PUT") {
    const contentType = request.headers.get("content-type") || "application/octet-stream";

    // 上传前按存储类型预检大小，GitHub 100MB 上限提前拒绝，避免读完大包才报错
    const declared = parseInt(request.headers.get("content-length") || "0", 10);
    const maxBytes = storage.type === "github" ? 100 * 1024 * 1024 : 50 * 1024 * 1024 * 1024;
    if (declared > 0 && declared > maxBytes) {
      const maxLabel = storage.type === "github" ? "100MB" : "50GB";
      return Response.json({ error: `文件大小超出 ${storage.type} 上限（最大 ${maxLabel}）` }, { status: 413 });
    }

    try {
      // Read body as ArrayBuffer first（content-length 可能缺失，读后再按实际大小校验）
      const bodyBuffer = await request.arrayBuffer();
      if (bodyBuffer.byteLength === 0) {
        return Response.json({ error: "未提供文件内容" }, { status: 400 });
      }
      if (bodyBuffer.byteLength > maxBytes) {
        const maxLabel = storage.type === "github" ? "100MB" : "50GB";
        return Response.json({ error: `文件大小超出 ${storage.type} 上限（最大 ${maxLabel}）` }, { status: 413 });
      }
      await withClientState(client, db, storageId, () => client.putObject(path, bodyBuffer, contentType));
      await logAudit(db, {
        action: "file.upload",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { size: bodyBuffer.byteLength, contentType },
      });
      return Response.json({ success: true, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件上传失败";
      const isSizeError = /超过|超出|上限/i.test(message);
      return Response.json({ error: message }, { status: isSizeError ? 413 : 500 });
    }
  }

  // Delete file or folder
  if (method === "DELETE") {
    // Recursive folder deletion
    if (action === "rmdir") {
      try {
        // List all objects in the folder
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "/", 1000, continuationToken)
            );

            // Add files
            for (const obj of result.objects) {
              if (!obj.isDirectory) {
                keys.push(obj.key);
              }
            }

            // Recursively list subfolders
            for (const obj of result.objects) {
              if (obj.isDirectory) {
                const subKeys = await listAll(obj.key);
                keys.push(...subKeys);
                // Also add the folder itself (empty object with trailing slash)
                keys.push(obj.key);
              }
            }

            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const keysToDelete = await listAll(path);

        // Delete all objects
        for (const key of keysToDelete) {
          await withClientState(client, db, storageId, () => client.deleteObject(key));
        }

        // Also try to delete the folder object itself
        try {
          await withClientState(client, db, storageId, () => client.deleteObject(path.endsWith("/") ? path : path + "/"));
        } catch {
          // Folder object might not exist, ignore
        }

        await logAudit(db, {
          action: "file.rmdir",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { deleted: keysToDelete.length },
        });
        return Response.json({ success: true, deleted: keysToDelete.length });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to delete folder" },
          { status: 500 }
        );
      }
    }

    // Single file deletion
    try {
      await withClientState(client, db, storageId, () => client.deleteObject(path));
      await logAudit(db, {
        action: "file.delete",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to delete file" },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
