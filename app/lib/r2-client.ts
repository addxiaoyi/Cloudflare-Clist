import { getMimeType } from "./file-utils";

export interface R2ObjectItem {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

export interface ListObjectsResult {
  objects: R2ObjectItem[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

// 原生 R2 binding 的封装：接口与 S3Client 对齐，使上层 API 无需感知底层差异。
// 通过 wrangler 的 r2_buckets 绑定注入 bucket 实例。
export class R2Client {
  private bucket: R2Bucket;
  private bucketName: string;
  private storageId: number;
  private basePath: string;

  constructor(
    bucket: R2Bucket,
    options: { bucketName?: string; storageId: number; basePath?: string }
  ) {
    this.bucket = bucket;
    this.bucketName = options.bucketName || "R2";
    this.storageId = options.storageId;
    this.basePath = options.basePath?.replace(/^\/|\/$/g, "") || "";
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
    const result = await this.bucket.list({
      prefix: fullPrefix || undefined,
      delimiter: delimiter || undefined,
      limit: Math.min(maxKeys, 1000),
      cursor: continuationToken,
      include: ["httpMetadata"],
    });

    const objects: R2ObjectItem[] = [];
    const prefixes: string[] = [];

    for (const obj of result.objects) {
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
        lastModified: obj.uploaded ? obj.uploaded.toISOString() : "",
        etag: obj.etag,
        isDirectory: false,
      });
    }

    for (const p of result.delimitedPrefixes) {
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
      isTruncated: result.truncated,
      nextContinuationToken: result.truncated ? result.cursor : undefined,
    };
  }

  async getObject(key: string): Promise<Response> {
    const obj = await this.bucket.get(this.getFullPath(key));
    if (!obj) {
      return new Response("Not Found", { status: 404 });
    }
    const headers = new Headers();
    const contentType = obj.httpMetadata?.contentType || getMimeType(key);
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
    headers.set("Content-Length", String(obj.size));
    if (obj.etag) {
      headers.set("ETag", obj.etag);
    }
    const lastModified = obj.uploaded?.toUTCString();
    if (lastModified) {
      headers.set("Last-Modified", lastModified);
    }
    return new Response(obj.body, { headers });
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    // 部分 workerd 版本支持 binding 内建 createSignedUrl（需账户开通 R2 签名 URL），
    // 类型未声明时用 any 探测，不可用则退回站内代理下载
    const bucket = this.bucket as R2Bucket & { createSignedUrl?: (path: string, opts: { expiresIn: number }) => Promise<string> };
    if (typeof bucket.createSignedUrl === "function") {
      try {
        return await bucket.createSignedUrl(this.getFullPath(key), {
          expiresIn: Math.floor(expiresIn),
        });
      } catch {
        // 签名 URL 未开通，走站内代理
      }
    }
    const encoded = this.getFullPath(key)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `/api/files/${this.storageId}/download/${encoded}?inline=1`;
  }

  async getSignedUploadPartUrl(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _expiresIn: number = 3600
  ): Promise<string> {
    // R2 多分片走站内代理上传（uploadPart），不提供直传签名 URL
    return "";
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    await this.bucket.put(this.getFullPath(key), body, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(this.getFullPath(key));
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const src = await this.bucket.get(this.getFullPath(sourceKey));
    if (!src) {
      throw new Error("R2 CopyObject failed: source not found");
    }
    await this.bucket.put(this.getFullPath(destKey), src.body, {
      httpMetadata: src.httpMetadata,
    });
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const isDirectory = path.endsWith("/");
    const cleanPath = path.replace(/\/$/, "");
    const parentPath = cleanPath.includes("/")
      ? cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1)
      : "";
    const newPath = parentPath + newName + (isDirectory ? "/" : "");
    if (isDirectory) {
      const keys = await this.listAll(cleanPath + "/");
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
      const keys = await this.listAll(path.replace(/\/$/, "") + "/");
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

  private async listAll(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.bucket.list({
        prefix,
        limit: 1000,
        cursor,
      });
      for (const obj of result.objects) {
        keys.push(obj.key);
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    await this.bucket.put(this.getFullPath(normalized), "", {
      httpMetadata: { contentType: "application/x-directory" },
    });
  }

  async headObject(
    key: string
  ): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const obj = await this.bucket.head(this.getFullPath(key));
    if (!obj) {
      return null;
    }
    return {
      contentLength: obj.size,
      contentType: obj.httpMetadata?.contentType || "application/octet-stream",
      lastModified: obj.uploaded ? obj.uploaded.toISOString() : "",
    };
  }

  async initiateMultipartUpload(
    key: string,
    contentType: string,
    _options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    const upload = await this.bucket.createMultipartUpload(this.getFullPath(key), {
      httpMetadata: { contentType },
    });
    return upload.uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream | ArrayBuffer,
    _contentLength?: number
  ): Promise<string> {
    const upload = await this.bucket.resumeMultipartUpload(this.getFullPath(key), uploadId);
    const part = await upload.uploadPart(partNumber, body);
    return part.etag.replace(/"/g, "");
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[]
  ): Promise<void> {
    const upload = await this.bucket.resumeMultipartUpload(this.getFullPath(key), uploadId);
    await upload.complete(
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const upload = await this.bucket.resumeMultipartUpload(this.getFullPath(key), uploadId);
    await upload.abort();
  }
}
