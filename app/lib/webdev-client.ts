export interface WebdevConfig {
  endpoint: string;
  username: string;
  password: string;
  basePath?: string;
}

export interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

export interface ListObjectsResult {
  objects: S3Object[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export class WebdevClient {
  private config: WebdevConfig;

  constructor(config: WebdevConfig) {
    this.config = config;
  }

  private getFullPath(path: string): string {
    const basePath = this.config.basePath?.replace(/^\/|\/$/g, "") || "";
    const cleanPath = path.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    if (basePath && cleanPath) {
      return `${basePath}/${cleanPath}`;
    }
    return basePath || cleanPath;
  }

  private getBasicAuth(): string {
    const credentials = `${this.config.username}:${this.config.password}`;
    return "Basic " + btoa(credentials);
  }

  private normalizeEndpoint(endpoint: string): string {
    const trimmed = endpoint?.trim() || "";
    if (!trimmed) {
      throw new Error("服务器地址未配置，请编辑存储后填写");
    }
    // 缺协议头时补 https://，避免 new URL() 抛 "Invalid URL string"
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withScheme.replace(/\/$/, "");
  }

  private encodePath(path: string): string {
    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  private buildUrl(path: string, directory: boolean = false): string {
    const endpoint = this.normalizeEndpoint(this.config.endpoint);
    const fullPath = this.getFullPath(path);
    const pathWithSlash =
      directory && fullPath && !fullPath.endsWith("/") ? `${fullPath}/` : fullPath;
    const encodedPath = this.encodePath(pathWithSlash);

    if (encodedPath) {
      return `${endpoint}/${encodedPath}`;
    }
    return directory ? `${endpoint}/` : endpoint;
  }

  private stripPathPrefix(path: string, prefix: string): string {
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
    const cleanPath = path.replace(/^\/+/, "");
    if (!cleanPrefix) {
      return cleanPath;
    }

    const lowerPath = cleanPath.toLowerCase();
    const lowerPrefix = cleanPrefix.toLowerCase();
    if (lowerPath === lowerPrefix) {
      return "";
    }
    if (lowerPath.startsWith(`${lowerPrefix}/`)) {
      return cleanPath.slice(cleanPrefix.length + 1);
    }
    return cleanPath;
  }

  private normalizeKey(path: string, directory: boolean = false): string {
    const normalized = path
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
      .join("/");

    if (directory && normalized) {
      return `${normalized}/`;
    }
    return normalized;
  }

  private decodeXml(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  private getPathFromHref(href: string): string {
    const endpoint = this.normalizeEndpoint(this.config.endpoint);
    const endpointPath = new URL(endpoint).pathname.replace(/^\/|\/$/g, "");
    const basePath = this.config.basePath?.replace(/^\/|\/$/g, "") || "";

    let pathname: string;
    try {
      pathname = new URL(href, `${endpoint}/`).pathname;
    } catch {
      pathname = href.split(/[?#]/, 1)[0];
    }

    let decodedPath = decodeURIComponent(pathname).replace(/^\/+/, "");
    decodedPath = this.stripPathPrefix(decodedPath, endpointPath);
    decodedPath = this.stripPathPrefix(decodedPath, basePath);

    return this.normalizeKey(decodedPath, decodedPath.endsWith("/"));
  }

  async listObjects(
    prefix: string = "",
    delimiter: string = "/",
    maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    let normalizedPrefix = prefix;
    if (normalizedPrefix && !normalizedPrefix.endsWith("/")) {
      normalizedPrefix = normalizedPrefix + "/";
    }

    const fullPrefix = this.getFullPath(normalizedPrefix);
    const url = this.buildUrl(normalizedPrefix, true);

    const xmlBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`;

    try {
      const response = await fetch(url, {
        method: "PROPFIND",
        headers: {
          Authorization: this.getBasicAuth(),
          "Content-Type": "application/xml",
          Depth: "1",
        },
        body: xmlBody,
      });

      if (!response.ok && response.status !== 207) {
        throw new Error(`WebDAV PROPFIND failed: ${response.status}`);
      }

      const xml = await response.text();
      return this.parsePropfindResponse(xml, fullPrefix, normalizedPrefix);
    } catch (error) {
      throw new Error(`WebDAV listObjects failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private parsePropfindResponse(
    xml: string,
    _fullPrefix: string,
    displayPrefix: string
  ): ListObjectsResult {
    const objects: S3Object[] = [];
    const prefixes: string[] = [];
    const normalizedDisplayPrefix = this.normalizeKey(displayPrefix, !!displayPrefix);
    const currentPath = normalizedDisplayPrefix.replace(/\/$/, "");

    // Parse response entries - support any namespace prefix.
    const responseRegex = /<[^:>]*:?response[^>]*>([\s\S]*?)<\/[^:>]*:?response>/gi;
    let match;

    while ((match = responseRegex.exec(xml)) !== null) {
      const response = match[1];
      const hrefMatch = response.match(/<[^:>]*:?href[^>]*>(.*?)<\/[^:>]*:?href>/i);
      if (!hrefMatch) continue;

      const href = this.decodeXml(hrefMatch[1]);
      const resourceTypeMatch = response.match(/<[^:>]*:?resourcetype[^>]*>([\s\S]*?)<\/[^:>]*:?resourcetype>/i);
      const isDirectory = !!(
        resourceTypeMatch && /<[^:>]*:?collection[\s\/>]/i.test(resourceTypeMatch[0])
      );

      let key = this.getPathFromHref(href);
      const keyWithoutSlash = key.replace(/\/$/, "");
      if (keyWithoutSlash === currentPath) {
        continue;
      }

      const displayNameMatch = response.match(/<[^:>]*:?displayname[^>]*>(.*?)<\/[^:>]*:?displayname>/i);
      let displayName = displayNameMatch?.[1] ? this.decodeXml(displayNameMatch[1]) : "";

      if (
        normalizedDisplayPrefix &&
        key &&
        !key.toLowerCase().startsWith(normalizedDisplayPrefix.toLowerCase())
      ) {
        key = "";
      }

      if (!key && displayName) {
        key = this.normalizeKey(`${normalizedDisplayPrefix}${displayName}`, isDirectory);
      }

      if (isDirectory) {
        key = this.normalizeKey(key, true);
      } else {
        key = this.normalizeKey(key);
      }

      if (!displayName) {
        const pathParts = key.replace(/\/$/, "").split("/");
        displayName = pathParts[pathParts.length - 1] || "";
      }
      if (!displayName || !key) continue;

      const contentLengthMatch = response.match(/<[^:>]*:?getcontentlength[^>]*>(.*?)<\/[^:>]*:?getcontentlength>/i);
      const size = contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : 0;

      const lastModifiedMatch = response.match(/<[^:>]*:?getlastmodified[^>]*>(.*?)<\/[^:>]*:?getlastmodified>/i);
      const lastModified = lastModifiedMatch ? this.decodeXml(lastModifiedMatch[1]) : "";

      if (isDirectory) {
        if (!prefixes.includes(key)) {
          prefixes.push(key);
        }
        objects.push({
          key,
          name: displayName,
          size: 0,
          lastModified,
          isDirectory: true,
        });
      } else {
        objects.push({
          key,
          name: displayName,
          size,
          lastModified,
          isDirectory: false,
        });
      }
    }

    return {
      objects: objects.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      }),
      prefixes,
      isTruncated: false,
      nextContinuationToken: undefined,
    };
  }
  async getObject(key: string): Promise<Response> {
    const url = this.buildUrl(key);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.getBasicAuth(),
        },
      });

      if (!response.ok) {
        throw new Error(`WebDAV GetObject failed: ${response.status}`);
      }

      return response;
    } catch (error) {
      throw new Error(`WebDAV getObject failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const url = this.buildUrl(key);

    let bodyData: ArrayBuffer;
    if (typeof body === "string") {
      bodyData = new TextEncoder().encode(body).buffer as ArrayBuffer;
    } else {
      bodyData = body;
    }

    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: this.getBasicAuth(),
          "Content-Type": contentType || "application/octet-stream",
        },
        body: bodyData,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`WebDAV PutObject failed: ${response.status} ${text}`);
      }
    } catch (error) {
      throw new Error(`WebDAV putObject failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const url = this.buildUrl(key, key.endsWith("/"));

    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: this.getBasicAuth(),
        },
      });

      if (!response.ok && response.status !== 204) {
        const text = await response.text();
        throw new Error(`WebDAV DeleteObject failed: ${response.status} ${text}`);
      }
    } catch (error) {
      throw new Error(`WebDAV deleteObject failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalizedPath = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    const url = this.buildUrl(normalizedPath, true);

    try {
      const response = await fetch(url, {
        method: "MKCOL",
        headers: {
          Authorization: this.getBasicAuth(),
        },
      });

      if (!response.ok && response.status !== 201) {
        const text = await response.text();
        throw new Error(`WebDAV MKCOL failed: ${response.status} ${text}`);
      }
    } catch (error) {
      throw new Error(`WebDAV createFolder failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const sourceUrl = this.buildUrl(sourceKey, sourceKey.endsWith("/"));
    const destUrl = this.buildUrl(destKey, destKey.endsWith("/"));

    try {
      const response = await fetch(sourceUrl, {
        method: "COPY",
        headers: {
          Authorization: this.getBasicAuth(),
          Destination: destUrl,
          Overwrite: "F",
        },
      });

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        const text = await response.text();
        throw new Error(`WebDAV COPY failed: ${response.status} ${text}`);
      }
    } catch (error) {
      throw new Error(`WebDAV copyObject failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  async headObject(
    key: string
  ): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const url = this.buildUrl(key);

    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          Authorization: this.getBasicAuth(),
        },
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`WebDAV HeadObject failed: ${response.status}`);
      }

      return {
        contentLength: parseInt(response.headers.get("content-length") || "0", 10),
        contentType: response.headers.get("content-type") || "application/octet-stream",
        lastModified: response.headers.get("last-modified") || "",
      };
    } catch (error) {
      throw new Error(`WebDAV headObject failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  // WebDAV doesn't support multipart uploads, these are no-ops or alternatives
  async initiateMultipartUpload(
    key: string,
    contentType: string,
    _options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    // Return a dummy upload ID - WebDAV doesn't have true multipart uploads
    // We'll use it as an indicator for PUT-based uploads
    return `webdev-${Date.now()}`;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream | ArrayBuffer,
    contentLength?: number
  ): Promise<string> {
    // For WebDAV, we can accumulate parts in a temporary file or handle differently
    // For now, return a dummy etag
    return `${partNumber}`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[]
  ): Promise<void> {
    // For WebDAV, multipart uploads aren't used this way
    // This is handled by direct PUT in the API layer
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    // No action needed for WebDAV
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    // WebDAV doesn't support signed URLs
    // Return a simple direct URL with basic auth
    // Note: This is not secure - basic auth in URL is deprecated
    // Prefer using Authorization header instead
    return this.buildUrl(key);
  }

  async getSignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = 3600
  ): Promise<string> {
    // WebDAV doesn't support this
    return this.getSignedUrl(key, expiresIn);
  }
}
