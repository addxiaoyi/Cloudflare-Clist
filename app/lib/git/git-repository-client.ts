import { getMimeType } from "../file-utils";
import type { DriveObject, ListObjectsResult } from "./types";
import type { GitConnection, GitPlatformAdapter, GitCommitMeta } from "./types";

// 与其它 clients 对齐的公开接口，保留 config/saving/DriveObject。
export class GitRepositoryClient {
  readonly config?: Record<string, any>;
  readonly saving?: Record<string, any>;
  readonly type: string;
  readonly label: string;

  private adapter: GitPlatformAdapter;
  private conn: GitConnection;

  private headSha = "";
  private commitDate = "";

  constructor(
    options: { config?: Record<string, any>; saving?: Record<string, any> },
    adapter: GitPlatformAdapter,
    conn: GitConnection
  ) {
    this.config = options.config;
    this.saving = options.saving;
    this.adapter = adapter;
    this.conn = conn;
    this.type = adapter.type;
    this.label = adapter.label;
  }

  getStateUpdates(): { config?: Record<string, any>; saving?: Record<string, any> } | null {
    return null;
  }

  // ---------------------------------------------------------------------------
  // 路径映射：display key <-> repoPath
  // ---------------------------------------------------------------------------

  private stripSlashes(s: string) {
    return s.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private toRepoPath(displayKey: string): string {
    const clean = this.stripSlashes(displayKey);
    if (!clean) return "";
    if (!this.conn.rootPath) return clean;
    return `${this.conn.rootPath}/${clean}`;
  }

  private toDisplayPath(repoPath: string): string {
    if (this.conn.rootPath) {
      if (repoPath === this.conn.rootPath) return "";
      if (repoPath.startsWith(this.conn.rootPath + "/")) {
        return repoPath.slice(this.conn.rootPath.length + 1);
      }
      // 越界路径丢弃 rootPath 前缀（更保险的是报错，但保持向后兼容）
      if (repoPath.startsWith(this.conn.rootPath)) return repoPath.slice(this.conn.rootPath.length);
    }
    return this.stripSlashes(repoPath);
  }

  private invalidateHeadCache() {
    this.headSha = "";
    this.commitDate = "";
  }

  private async resolveHead(): Promise<GitCommitMeta> {
    if (this.headSha && this.commitDate) return { sha: this.headSha, date: this.commitDate };
    const meta = await this.adapter.headCommit(this.conn);
    this.headSha = meta.sha;
    this.commitDate = meta.date;
    return meta;
  }

  private parseRange(header: string, size: number): { start: number; end: number } | null {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!m) return null;
    const start = m[1] ? parseInt(m[1], 10) : undefined;
    const end = m[2] ? parseInt(m[2], 10) : undefined;
    if (start === undefined) {
      const suffix = end ?? 0;
      const s = Math.max(0, size - suffix);
      return { start: s, end: size - 1 };
    }
    let s = start;
    let e = end === undefined ? size - 1 : Math.min(end, size - 1);
    if (s > e || s >= size) return null;
    return { start: s, end: e };
  }

  // ---------------------------------------------------------------------------
  // StorageClient 接口
  // ---------------------------------------------------------------------------

  async listObjects(
    prefix = "",
    delimiter = "/",
    maxKeys = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    const repoPath = this.toRepoPath(prefix);

    if (delimiter === "/") {
      const maxItems = maxKeys > 0 ? maxKeys : undefined;
      const result = await this.adapter.listDir(this.conn, repoPath, { maxItems, token: continuationToken });
      if (!result) return { objects: [], prefixes: [], isTruncated: false };

      const { date } = await this.resolveHead();
      const objects: DriveObject[] = [];
      const prefixes: string[] = [];

      for (const e of result.entries) {
        const isDir = e.type === "dir";
        const display = this.toDisplayPath(e.path);
        const key = isDir ? `${display}/` : display;
        objects.push({
          key,
          name: e.name,
          size: e.size,
          lastModified: date,
          isDirectory: isDir,
          etag: e.sha,
        });
        if (isDir) prefixes.push(key);
      }

      objects.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return {
        objects,
        prefixes,
        isTruncated: !!result.nextToken,
        nextContinuationToken: result.nextToken ?? undefined,
      };
    }

    // bulk mode: recursive listing
    if (!this.adapter.supportsListTree) {
      throw new Error(`${this.label} 不支持递归列表，请改用目录遍历`);
    }
    const tree = await this.adapter.listTree(this.conn);
    if (!tree) return { objects: [], prefixes: [], isTruncated: false };
    const { date } = await this.resolveHead();
    const prefixTrail = repoPath ? repoPath + "/" : "";
    const objects: DriveObject[] = [];
    for (const e of tree) {
      if (e.type !== "file") continue;
      if (prefixTrail && !e.path.startsWith(prefixTrail)) continue;
      const display = this.toDisplayPath(e.path);
      objects.push({
        key: display,
        name: e.path.split("/").pop() || e.path,
        size: e.size || 0,
        lastModified: date,
        isDirectory: false,
        etag: e.sha,
      });
    }
    objects.sort((a, b) => a.name.localeCompare(b.name));
    return { objects, prefixes: [], isTruncated: false };
  }

  async getObject(key: string, options?: { range?: string }): Promise<Response> {
    const repoPath = this.toRepoPath(key);
    const read = await this.adapter.readFile(this.conn, repoPath);
    const sizeBytes = read.size;
    const contentType = getMimeType(key) || "application/octet-stream";

    if (options?.range) {
      const range = this.parseRange(options.range, sizeBytes);
      if (range) {
        const part = read.bytes.slice(range.start, range.end + 1);
        return new Response(part, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(part.byteLength),
            "Content-Range": `bytes ${range.start}-${range.end}/${sizeBytes}`,
            "Accept-Ranges": "bytes",
          },
        });
      }
      return new Response(read.bytes, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(sizeBytes),
          "Accept-Ranges": "bytes",
        },
      });
    }

    return new Response(read.bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(sizeBytes),
        "Accept-Ranges": "bytes",
      },
    });
  }

  async getSignedUrl(key: string, _expiresIn = 3600): Promise<string> {
    const repoPath = this.toRepoPath(key);
    return this.adapter.signedUrl(this.conn, repoPath);
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const repoPath = this.toRepoPath(key);
    const stat = await this.adapter.statFile(this.conn, repoPath);
    if (!stat) return null;
    const { date } = await this.resolveHead();
    return {
      contentLength: stat.size,
      contentType: getMimeType(key) || "application/octet-stream",
      lastModified: date,
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    if (contentType?.startsWith("application/x-directory")) return;
    const repoPath = this.toRepoPath(key);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
    if (bytes.length > this.adapter.maxFileBytes) {
      const sizeMB = Math.round(bytes.length / (1024 * 1024) * 100) / 100;
      throw new Error(`${this.label} 文件超过 ${this.adapter.maxFileLabel}（${sizeMB} MB），请使用小文件或分批上传`);
    }
    const fileName = key.split("/").pop() || "文件";
    await this.adapter.writeFile(this.conn, repoPath, bytes, `上传 ${fileName}`);
    this.invalidateHeadCache();
  }

  async deleteObject(key: string): Promise<void> {
    const repoPath = this.toRepoPath(key);
    const stat = await this.adapter.statFile(this.conn, repoPath);
    if (!stat) return;
    await this.adapter.deleteFile(this.conn, repoPath, `删除 ${key.split("/").pop() || "文件"}`);
    this.invalidateHeadCache();
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = this.stripSlashes(folderPath);
    if (!normalized) return;
    const existing = await this.adapter.listDir(this.conn, this.toRepoPath(normalized), { maxItems: 1 });
    if (existing && existing.entries.length > 0) return;
    await this.adapter.writeFile(this.conn, this.toRepoPath(`${normalized}/.gitkeep`), new Uint8Array(), `创建目录 ${folderPath}`);
    this.invalidateHeadCache();
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const srcPath = this.toRepoPath(sourceKey);
    const stat = await this.adapter.statFile(this.conn, srcPath);
    if (!stat) throw new Error("源文件不存在");
    const read = await this.adapter.readFile(this.conn, srcPath);
    await this.adapter.writeFile(this.conn, this.toRepoPath(destKey), new Uint8Array(read.bytes), `复制 ${sourceKey} -> ${destKey}`);
    this.invalidateHeadCache();
  }

  async initiateMultipartUpload(_key: string, _contentType: string, _options?: { size?: number; chunkSize?: number }): Promise<string> {
    throw new Error(`${this.label} 存储不支持分片上传`); 
  }
  async uploadPart(): Promise<string> {
    throw new Error(`${this.label} 存储不支持分片上传`);
  }
  async completeMultipartUpload(): Promise<void> {
    return;
  }
  async abortMultipartUpload(): Promise<void> {
    return;
  }
  async getSignedUploadPartUrl(): Promise<string> {
    return "";
  }
}
