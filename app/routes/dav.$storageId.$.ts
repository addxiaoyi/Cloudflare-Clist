import type { Route } from "./+types/dav.$storageId.$";
import { getStorageById, getAllStorages, initDatabase, updateStorage } from "~/lib/storage";
import { createClient, type StorageClient, type ClientEnv } from "~/lib/client-factory";
import { fileResponseHeaders, isUnsafeInlineType } from "~/lib/file-utils";
import { getRequestMeta, logAudit, isRateLimited } from "~/lib/audit";

// 路径穿越防护：拒绝包含 ".." 段、空段路径或控制字符的路径（与 api.files 同规则）
function assertSafePath(path: string): void {
  if (!path) return;
  if (/[\u0000-\u001f]/.test(path)) {
    throw new Error("路径包含非法控制字符");
  }
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error("路径不能包含 .. 或 . 段");
  }
}

// WebDAV server endpoint - provides WebDAV access to storages

function generatePropfindResponse(
  objects: Array<{ key: string; name: string; size: number; lastModified: string; isDirectory: boolean }>,
  requestPath: string,
  baseUrl: string
): string {
  const xmlResponses: string[] = [];
  const joinHref = (...parts: string[]) => {
    const path = parts
      .map((part, index) => index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/");
    return path || "/";
  };
  const collectionHref = (href: string) => href.endsWith("/") ? href : `${href}/`;

  // Add the current directory itself
  const currentHref = joinHref(baseUrl, requestPath);
  xmlResponses.push(`
    <D:response>
      <D:href>${escapeXml(collectionHref(currentHref))}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
          <D:displayname>${escapeXml(requestPath.split("/").pop() || "root")}</D:displayname>
          <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`);

  for (const obj of objects) {
    const href = joinHref(baseUrl, obj.key || joinHref(requestPath, obj.name));
    
    if (obj.isDirectory) {
      xmlResponses.push(`
    <D:response>
      <D:href>${escapeXml(collectionHref(href))}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
          <D:displayname>${escapeXml(obj.name)}</D:displayname>
          <D:getlastmodified>${obj.lastModified ? new Date(obj.lastModified).toUTCString() : new Date().toUTCString()}</D:getlastmodified>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`);
    } else {
      xmlResponses.push(`
    <D:response>
      <D:href>${escapeXml(href)}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype/>
          <D:displayname>${escapeXml(obj.name)}</D:displayname>
          <D:getcontentlength>${obj.size}</D:getcontentlength>
          <D:getlastmodified>${obj.lastModified ? new Date(obj.lastModified).toUTCString() : new Date().toUTCString()}</D:getlastmodified>
          <D:getcontenttype>${getContentType(obj.name)}</D:getcontenttype>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`);
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${xmlResponses.join("")}
</D:multistatus>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const escapeHtml = escapeXml;

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeTypes: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    xml: "application/xml",
    txt: "text/plain",
    md: "text/markdown",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

// Validate Basic Auth credentials
async function validateWebdavAuth(
  request: Request,
  env: { WEBDAV_USERNAME?: string; WEBDAV_PASSWORD?: string; ADMIN_USERNAME?: string; ADMIN_PASSWORD?: string }
): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }

  try {
    const credentials = atob(authHeader.slice(6));
    const [username, password] = credentials.split(":");

    // Check WebDAV-specific credentials first
    const webdavUsername = env.WEBDAV_USERNAME || env.ADMIN_USERNAME || "admin";
    const webdavPassword = env.WEBDAV_PASSWORD || env.ADMIN_PASSWORD || "changeme";

    // 恒定时间比较，防时序侧信道
    return timingSafeEqual(username, webdavUsername) && timingSafeEqual(password, webdavPassword);
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

function createUnauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Starx WebDAV"',
      "Content-Type": "text/plain",
    },
  });
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

// Unified WebDAV request handler
export async function handleWebdavRequest(
  request: Request,
  params: { storageId?: string; "*"?: string },
  context: any
): Promise<Response> {
  const method = request.method.toUpperCase();

  // Handle OPTIONS for WebDAV discovery
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        DAV: "1, 2",
        Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE",
        "MS-Author-Via": "DAV",
      },
    });
  }

  const db = context.cloudflare.env.DB;
  const env = context.cloudflare.env as {
    WEBDAV_ENABLED?: string;
    WEBDAV_USERNAME?: string;
    WEBDAV_PASSWORD?: string;
    ADMIN_USERNAME?: string;
    ADMIN_PASSWORD?: string;
  };

  // Check if WebDAV is enabled
  if (env.WEBDAV_ENABLED !== "true") {
    return new Response("WebDAV is disabled", { status: 403 });
  }

  await initDatabase(db);

  // Validate authentication（失败记审计 + IP 限流，防 Basic Auth 爆破）
  const isAuthenticated = await validateWebdavAuth(request, env);
  if (!isAuthenticated) {
    const meta = getRequestMeta(request);
    if (await isRateLimited(db, meta.ip, "webdav.auth_failed")) {
      return new Response("Too many failed attempts", { status: 429 });
    }
    await logAudit(db, {
      action: "webdav.auth_failed",
      userType: "guest",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return createUnauthorizedResponse();
  }

  const storageId = parseInt(params.storageId || "0", 10);
  // params["*"] 是 URL 编码态，需解码后再作为对象 key，否则非 ASCII/空格文件名被双重编码入库
  let path = params["*"] || "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // 保留原始 path 以防编码损坏
  }

  // 防路径穿越：任何方法都不允许 .. / . 段
  if (path && /[\u0000-\u001f]/.test(path)) {
    return new Response("路径包含非法控制字符", { status: 400 });
  }
  if (path && path.split("/").some((seg) => seg === ".." || seg === ".")) {
    return new Response("路径不能包含 .. 或 . 段", { status: 400 });
  }

  // Handle listing all storages at the root
  if (storageId === 0) {
    if (method === "PROPFIND") {
      const storages = await getAllStorages(db);
      const url = new URL(request.url);
      const baseUrl = url.pathname.replace(/\/$/, "");

      const xmlResponses: string[] = [];

      // Root collection
      xmlResponses.push(`
    <D:response>
      <D:href>${escapeXml(baseUrl + "/")}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
          <D:displayname>Starx Storages</D:displayname>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`);

      // Each storage as a folder
      for (const storage of storages) {
        xmlResponses.push(`
    <D:response>
      <D:href>${escapeXml(baseUrl.replace(/\/0$/, "") + "/" + storage.id + "/")}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
          <D:displayname>${escapeXml(storage.name)}</D:displayname>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`);
      }

      const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${xmlResponses.join("")}
</D:multistatus>`;

      return new Response(xml, {
        status: 207,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "DAV": "1, 2",
        },
      });
    }

    // Root doesn't support modification
    if (["PUT", "DELETE", "MKCOL", "COPY", "MOVE"].includes(method)) {
      return new Response("Cannot modify root", { status: 403 });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return new Response("Storage not found", { status: 404 });
  }

  const client = createClient(storage, context.cloudflare.env, storageId);
  const url = new URL(request.url);
  const baseUrl = `/dav/${storageId}`;

  // Handle modification methods
  if (["PUT", "DELETE", "MKCOL", "COPY", "MOVE"].includes(method)) {
    // PUT - Upload file
    if (method === "PUT") {
      try {
        const contentType = request.headers.get("content-type") || "application/octet-stream";
        const bodyBuffer = await request.arrayBuffer();
        await withClientState(client, db, storageId, () => client.putObject(path, bodyBuffer, contentType));
        return new Response(null, { status: 201 });
      } catch (error) {
        console.error("PUT error:", error);
        return new Response("Failed to upload file", { status: 500 });
      }
    }

    // DELETE - Delete file or folder
    if (method === "DELETE") {
      try {
        await withClientState(client, db, storageId, () => client.deleteObject(path));
        return new Response(null, { status: 204 });
      } catch (error) {
        console.error("DELETE error:", error);
        return new Response("Failed to delete", { status: 500 });
      }
    }

    // MKCOL - Create directory
    if (method === "MKCOL") {
      try {
        await withClientState(client, db, storageId, () => client.createFolder(path));
        return new Response(null, { status: 201 });
      } catch (error) {
        console.error("MKCOL error:", error);
        try {
          await withClientState(client, db, storageId, () => client.listObjects(path));
          return new Response(null, { status: 204 });
        } catch {
          return new Response("Failed to create directory", { status: 500 });
        }
      }
    }

    // COPY - Copy file
    if (method === "COPY") {
      try {
        const destinationHeader = request.headers.get("Destination");
        if (!destinationHeader) {
          return new Response("Destination header required", { status: 400 });
        }

        const destUrl = new URL(destinationHeader, url.origin + "/");
        let destPath = destUrl.pathname.replace(`/dav/${storageId}/`, "");
        try { destPath = decodeURIComponent(destPath); } catch {}
        // 防穿越：目标路径同样拒绝 .. / . 段
        if (destPath.split("/").some((seg) => seg === ".." || seg === ".") || /[\u0000-\u001f]/.test(destPath)) {
          return new Response("目标路径不能包含 .. 或 . 段", { status: 400 });
        }

        await withClientState(client, db, storageId, () => client.copyObject(path, destPath));
        return new Response(null, { status: 201 });
      } catch (error) {
        console.error("COPY error:", error);
        return new Response("Failed to copy", { status: 500 });
      }
    }

    // MOVE - Move file
    if (method === "MOVE") {
      try {
        const destinationHeader = request.headers.get("Destination");
        if (!destinationHeader) {
          return new Response("Destination header required", { status: 400 });
        }

        const destUrl = new URL(destinationHeader, url.origin + "/");
        let destPath = destUrl.pathname.replace(`/dav/${storageId}/`, "");
        try { destPath = decodeURIComponent(destPath); } catch {}
        // 防穿越：目标路径同样拒绝 .. / . 段
        if (destPath.split("/").some((seg) => seg === ".." || seg === ".") || /[\u0000-\u001f]/.test(destPath)) {
          return new Response("目标路径不能包含 .. 或 . 段", { status: 400 });
        }

        const canDirectMove = typeof (client as { moveObject?: (path: string, destPath: string) => Promise<void> }).moveObject === "function";
        if (canDirectMove) {
          await withClientState(
            client,
            db,
            storageId,
            () => (client as { moveObject: (path: string, destPath: string) => Promise<void> }).moveObject(path, destPath)
          );
        } else {
          await withClientState(client, db, storageId, () => client.copyObject(path, destPath));
          await withClientState(client, db, storageId, () => client.deleteObject(path));
        }
        return new Response(null, { status: 201 });
      } catch (error) {
        console.error("MOVE error:", error);
        return new Response("Failed to move", { status: 500 });
      }
    }
  }

  // PROPFIND - List directory contents
  if (method === "PROPFIND") {
    try {
      const result = await withClientState(client, db, storageId, () => client.listObjects(path));
      const xml = generatePropfindResponse(result.objects, path, baseUrl);
      return new Response(xml, {
        status: 207,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "DAV": "1, 2",
        },
      });
    } catch (error) {
      console.error("PROPFIND error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // GET - Download file
  if (method === "GET" || method === "HEAD") {
    try {
      // Check if it's a directory
      if (path.endsWith("/") || path === "") {
        // Return a simple HTML directory listing for browser access
        const result = await withClientState(client, db, storageId, () => client.listObjects(path));
        const displayPath = path || "/";
        const html = `<!DOCTYPE html>
<html>
<head><title>Index of ${escapeHtml(displayPath)}</title></head>
<body>
<h1>Index of ${escapeHtml(displayPath)}</h1>
<ul>
${path ? `<li><a href="../">../</a></li>` : ""}
${result.objects.map(obj => 
  obj.isDirectory 
    ? `<li><a href="${encodeURIComponent(obj.name)}/">${escapeHtml(obj.name)}/</a></li>`
    : `<li><a href="${encodeURIComponent(obj.name)}">${escapeHtml(obj.name)}</a> (${obj.size} bytes)</li>`
).join("\n")}
</ul>
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const response = await withClientState(client, db, storageId, () => client.getObject(path));
      const contentType = response.headers.get("content-type") || getContentType(path);
      const contentLength = response.headers.get("content-length");
      // 危险类型（HTML/SVG/XML/JS/CSS）强制附件下载 + nosniff，防同源脚本执行
      const unsafeInline = isUnsafeInlineType(contentType);
      const disposition = unsafeInline ? "attachment" : "inline";

      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `${disposition}; filename="${encodeURIComponent(path.split("/").pop() || "download")}"`,
            ...fileResponseHeaders(contentType, !unsafeInline),
            ...(contentLength ? { "Content-Length": contentLength } : {}),
          },
        });
      }

      return new Response(response.body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `${disposition}; filename="${encodeURIComponent(path.split("/").pop() || "download")}"`,
          ...fileResponseHeaders(contentType, !unsafeInline),
          ...(contentLength ? { "Content-Length": contentLength } : {}),
        },
      });
    } catch (error) {
      console.error("GET error:", error);
      return new Response("Not Found", { status: 404 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
}

// Handle all WebDAV methods via loader for GET, PROPFIND, etc.
export async function loader({ request, params, context }: Route.LoaderArgs) {
  return handleWebdavRequest(request, params, context);
}

// Handle modification methods via action
export async function action({ request, params, context }: Route.ActionArgs) {
  return handleWebdavRequest(request, params, context);
}
