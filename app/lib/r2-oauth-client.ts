import { getMimeType } from "./file-utils";
import { type R2ObjectItem, type ListObjectsResult } from "./r2-client";

// 通过 Cloudflare API 访问其他账户的 R2 存储桶
// 使用用户授权的 access token
export class R2OAuthClient {
  private accountId: string;
  private bucketName: string;
  private accessToken: string;
  private basePath: string;
  private storageId: number;
  private apiBase = "https://api.cloudflare.com/client/v4/accounts";

  constructor(config: {
    accountId: string;
    bucketName: string;
    accessToken: string;
    basePath?: string;
    storageId?: number;
  }) {
    this.accountId = config.accountId;
    this.bucketName = config.bucketName;
    this.accessToken = config.accessToken;
    this.basePath = config.basePath?.replace(/^\/|\/$/g, "") || "";
    this.storageId = config.storageId || 0;
  }

  private getFullPath(path: string): string {
    const cleanPath = path.replace(/^\//, "");
    return this.basePath ? `${this.basePath}/${cleanPath}` : cleanPath;
  }

  private getDisplayPath(fullKey: string): string {
    if (!this.basePath) {
      return fullKey;
    }
    return fullKey.startsWith(this.basePath + "/")
      ? fullKey.slice(this.basePath.length + 1)
      : fullKey;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async listObjects(
    prefix: string = "",
    delimiter: string = "/",
    maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    let normalizedPrefix = prefix;
    if (normalizedPrefix && !normalizedPrefix.endsWith("/")) {
      normalizedPrefix += "/";
    }

    const fullPrefix = this.getFullPath(normalizedPrefix);
    const params = new URLSearchParams({
      prefix: fullPrefix || "",
      delimiter: delimiter || "",
      limit: Math.min(maxKeys, 1000).toString(),
    });
    if (continuationToken) {
      params.set("cursor", continuationToken);
    }

    const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects?${params}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`R2 ListObjects failed: ${res.status}`);
    }

    const data: Record<string, any> = await res.json();
    const result: Record<string, any> = data.result || {};
    const objects: R2ObjectItem[] = [];
    const prefixes: string[] = [];

    for (const obj of result.objects || []) {
      const key = this.getDisplayPath(obj.key);
      const name = key.startsWith(normalizedPrefix)
        ? key.slice(normalizedPrefix.length)
        : key;
      if (!name || name.endsWith("/")) {
        continue;
      }
      objects.push({
        key,
        name,
        size: obj.size,
        lastModified: obj.uploaded || "",
        etag: obj.etag,
        isDirectory: false,
      });
    }

    for (const p of result.delimitedPrefixes || []) {
      const display = this.getDisplayPath(p);
      const name = display.startsWith(normalizedPrefix)
        ? display.slice(normalizedPrefix.length).replace(/\/$/, "")
        : display.replace(/\/$/, "");
      if (name) {
        prefixes.push(display);
        objects.push({
          key: display,
          name,
          size: 0,
          lastModified: "",
          isDirectory: true,
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
      isTruncated: result.truncated || false,
      nextContinuationToken: result.cursor,
    };
  }

  async getObject(key: string): Promise<Response> {
    const path = this.getFullPath(key);
    const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!res.ok) {
      return new Response(res.statusText, { status: res.status });
    }

    const headers = new Headers(res.headers);
    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", getMimeType(key));
    }
    return new Response(res.body, { headers, status: res.status });
  }

  async headObject(
    key: string
  ): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const path = this.getFullPath(key);
    const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      return null;
    }
    return {
      contentLength: parseInt(res.headers.get("Content-Length") || "0", 10),
      contentType: res.headers.get("Content-Type") || "application/octet-stream",
      lastModified: res.headers.get("Last-Modified") || "",
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const path = this.getFullPath(key);
    const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 PutObject failed: ${res.status} ${text}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const path = this.getFullPath(key);
    const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`R2 DeleteObject failed: ${res.status}`);
    }
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const src = await this.getObject(sourceKey);
    if (!src.ok) {
      throw new Error("R2 CopyObject failed: source not found");
    }
    const destPath = this.getFullPath(destKey);
    const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects/${encodeURIComponent(destPath)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": src.headers.get("Content-Type") || "application/octet-stream",
      },
      body: await src.arrayBuffer(),
    });
    if (!res.ok) {
      throw new Error(`R2 CopyObject failed: ${res.status}`);
    }
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    await this.putObject(normalized, "", "application/x-directory");
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const isDirectory = path.endsWith("/");
    const cleanPath = path.replace(/\/$/, "");
    const parentPath = cleanPath.includes("/")
      ? cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1)
      : "";
    const newPath = parentPath + newName + (isDirectory ? "/" : "");
    if (isDirectory) {
      const keys = await this.listAllKeys(cleanPath + "/");
      for (const key of keys) {
        await this.copyObject(key, newPath + key.substring(cleanPath.length + 1));
      }
      for (const key of keys) {
        await this.deleteObject(key);
      }
      await this.deleteObject(cleanPath + "/").catch(() => undefined);
    } else {
      await this.copyObject(path, newPath);
      await this.deleteObject(path);
    }
  }

  async moveObject(path: string, newPath: string): Promise<void> {
    const isDirectory = path.endsWith("/");
    if (isDirectory) {
      const keys = await this.listAllKeys(path.replace(/\/$/, "") + "/");
      for (const key of keys) {
        await this.copyObject(key, newPath + key.substring(path.length));
      }
      for (const key of keys) {
        await this.deleteObject(key);
      }
      await this.deleteObject(path).catch(() => undefined);
    } else {
      await this.copyObject(path, newPath);
      await this.deleteObject(path);
    }
  }

  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        prefix,
        limit: "1000",
      });
      if (cursor) {
        params.set("cursor", cursor);
      }
      const url = `${this.apiBase}/${this.accountId}/r2/buckets/${this.bucketName}/objects?${params}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error("Failed to list objects");
      }
      const data: Record<string, any> = await res.json();
      for (const obj of data.result?.objects || []) {
        keys.push(obj.key);
      }
      cursor = data.result?.truncated ? data.result?.cursor : undefined;
    } while (cursor);
    return keys;
  }

  // 不支持分片上传
  async initiateMultipartUpload(
    _key: string,
    _contentType: string,
    _options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    throw new Error("R2 OAuth 不支持分片上传");
  }

  async getSignedUploadPartUrl(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _expiresIn: number = 3600
  ): Promise<string> {
    return "";
  }

  async uploadPart(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _body: ReadableStream | ArrayBuffer,
    _contentLength?: number
  ): Promise<string> {
    throw new Error("R2 OAuth 不支持分片上传");
  }

  async completeMultipartUpload(
    _key: string,
    _uploadId: string,
    _parts: { partNumber: number; etag: string }[]
  ): Promise<void> {
    throw new Error("R2 OAuth 不支持分片上传");
  }

  async abortMultipartUpload(_key: string, _uploadId: string): Promise<void> {
    throw new Error("R2 OAuth 不支持分片上传");
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const encoded = this.getFullPath(key)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `/api/files/${this.storageId}/download/${encoded}?inline=1&expires=${expiresIn}`;
  }
}