import { getMimeType } from "./file-utils";
import { stripLeadingSlash, stripTrailingSlash } from "./drive-utils";

export interface DriveObject {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

export interface ListObjectsResult {
  objects: DriveObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

interface ContentsEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule" | "other";
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

interface GitTree {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

interface GitHubCommit {
  commit: { author: { date: string } };
}

interface GitHubRef {
  object: { sha: string };
}

const DEFAULT_BRANCH = "main";
const REPO_MAX_FILE_BYTES = 100 * 1024 * 1024;

export class GithubClient {
  readonly config?: Record<string, any>;
  readonly saving?: Record<string, any>;
  private owner: string;
  private repo: string;
  private token: string;
  private apiBase: string;
  private branch: string;
  private rootPath: string;

  private headSha = "";
  private commitDate = "";

  constructor(options: { config?: Record<string, any>; saving?: Record<string, any> }) {
    const cfg = options.config || {};
    this.config = options.config;
    this.saving = options.saving;

    const repo = typeof cfg.repo === "string" ? cfg.repo.trim() : "";
    const m = /^([^/]+)\/([^/]+)$/.exec(repo);
    if (!m) {
      throw new Error("GitHub 存储需填写仓库（格式 owner/repo）");
    }
    this.owner = m[1];
    this.repo = m[2];

    this.token = typeof cfg.token === "string" && cfg.token.length > 0 ? cfg.token : "";
    if (!this.token) {
      throw new Error("GitHub 存储需填写 Personal Access Token");
    }
    this.apiBase = typeof cfg.api_base === "string" && cfg.api_base.length > 0
      ? cfg.api_base.replace(/\/+$/, "")
      : "https://api.github.com";
    this.branch = typeof cfg.branch === "string" && cfg.branch.length > 0 ? cfg.branch : DEFAULT_BRANCH;

    const root = typeof cfg.root_path === "string" ? cfg.root_path : "";
    this.rootPath = root.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  getStateUpdates(): { config?: Record<string, any>; saving?: Record<string, any> } | null {
    return null;
  }

  private toRepoPath(displayKey: string): string {
    const clean = stripLeadingSlash(displayKey).replace(/\/+$/, "");
    if (!clean) return "";
    if (!this.rootPath) return clean;
    return `${this.rootPath}/${clean}`;
  }

  private toDisplayPath(repoPath: string): string {
    if (this.rootPath) {
      if (repoPath === this.rootPath) return "";
      if (repoPath.startsWith(this.rootPath + "/")) return repoPath.slice(this.rootPath.length + 1);
    }
    return repoPath.replace(/^\/+/, "");
  }

  private encodePathInRepo(repoPath: string): string {
    return repoPath.split("/").map(encodeURIComponent).join("/");
  }

  private base64FromBytes(bytes: Uint8Array | ArrayBuffer): string {
    let bin = "";
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK) as unknown as number[]);
    }
    return btoa(bin);
  }

  private async gh(path: string, init?: RequestInit, rawMedia = false): Promise<Response> {
    const url = `${this.apiBase}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: rawMedia ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        ...(init?.headers || {}),
      },
    });
  }

  private async ghJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.gh(path, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    if (res.status === 204) return {} as T;
    return res.json() as T;
  }

  private async resolveHead(): Promise<{ sha: string; date: string }> {
    if (this.headSha && this.commitDate) {
      return { sha: this.headSha, date: this.commitDate };
    }
    const ref: GitHubRef = await this.ghJson(`/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const sha = ref.object.sha;
    const commit: GitHubCommit = await this.ghJson(`/repos/${this.owner}/${this.repo}/git/commits/${sha}`);
    this.headSha = sha;
    this.commitDate = commit.commit.author.date;
    return { sha, date: commit.commit.author.date };
  }

  private async fetchDirectory(repoPath: string): Promise<ContentsEntry[] | null> {
    const encoded = repoPath ? `/${this.encodePathInRepo(repoPath)}` : "";
    const res = await this.gh(`${encoded}?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) {
      return null;
    }
    return raw as ContentsEntry[];
  }

  private async fetchTreeRecursive(): Promise<GitTree | null> {
    const { sha } = await this.resolveHead();
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/git/trees/${sha}?recursive=1`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    return res.json() as Promise<GitTree>;
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
  // StorageClient
  // ---------------------------------------------------------------------------

  async listObjects(
    prefix = "",
    delimiter = "/",
    _maxKeys = 1000,
    _continuationToken?: string
  ): Promise<ListObjectsResult> {
    const repoPath = this.toRepoPath(prefix);

    if (delimiter === "/") {
      const items = await this.fetchDirectory(repoPath);
      if (!items) {
        return { objects: [], prefixes: [], isTruncated: false };
      }
      const { date } = await this.resolveHead();
      const objects: DriveObject[] = [];
      const prefixes: string[] = [];
      for (const item of items) {
        if (item.type === "symlink" || item.type === "submodule") continue;
        const display = this.toDisplayPath(item.path);
        const key = item.type === "dir" ? `${display}/` : display;
        const isDir = item.type === "dir";
        objects.push({
          key,
          name: item.name,
          size: item.type === "file" ? item.size : 0,
          lastModified: date,
          isDirectory: isDir,
          etag: item.sha,
        });
        if (isDir) prefixes.push(key);
      }
      objects.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { objects, prefixes, isTruncated: false };
    }

    // Recursive / bulk mode (delimiter != "/") — return blobs only
    const tree = await this.fetchTreeRecursive();
    if (!tree) {
      return { objects: [], prefixes: [], isTruncated: false };
    }
    const { date } = await this.resolveHead();
    const prefixTrail = repoPath ? repoPath + "/" : "";
    const objects: DriveObject[] = [];
    for (const entry of tree.tree) {
      if (entry.type !== "blob") continue;
      if (prefixTrail && !entry.path.startsWith(prefixTrail)) continue;
      const display = this.toDisplayPath(entry.path);
      objects.push({
        key: display,
        name: display.split("/").pop() || display,
        size: entry.size || 0,
        lastModified: date,
        isDirectory: false,
        etag: entry.sha,
      });
    }
    objects.sort((a, b) => a.name.localeCompare(b.name));
    return { objects, prefixes: [], isTruncated: tree.truncated };
  }

  async getObject(key: string, options?: { range?: string }): Promise<Response> {
    const repoPath = this.toRepoPath(key);
    const meta = await this.fetchContentsMeta(repoPath);
    if (!meta) throw new Error("File not found");
    const { sha, dir } = meta;
    if (dir) return new Response("Directory", { status: 400 });
    if (!sha) throw new Error("File not found");

    const encoded = this.encodePathInRepo(repoPath);
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(this.branch)}`, {}, true);
    if (!res.ok) {
      throw new Error(`GitHub download error: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const size = buf.byteLength;
    const contentType = getMimeType(key) || "application/octet-stream";

    if (options?.range) {
      const range = this.parseRange(options.range, size);
      if (range) {
        const part = buf.slice(range.start, range.end + 1);
        return new Response(part, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(part.byteLength),
            "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
            "Accept-Ranges": "bytes",
          },
        });
      }
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
        },
      });
    }

    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    });
  }

  async getSignedUrl(key: string, _expiresIn = 3600): Promise<string> {
    const repoPath = this.toRepoPath(key);
    const encoded = this.encodePathInRepo(repoPath);
    return `${this.apiBase}/repos/${this.owner}/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(this.branch)}`;
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const meta = await this.fetchContentsMeta(this.toRepoPath(key));
    if (!meta || meta.dir) return null;
    const { date } = await this.resolveHead();
    return {
      contentLength: meta.size,
      contentType: getMimeType(key) || "application/octet-stream",
      lastModified: date,
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    if (contentType?.startsWith("application/x-directory")) return;
    const repoPath = this.toRepoPath(key);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
    if (bytes.length > REPO_MAX_FILE_BYTES) {
      throw new Error(`GitHub 文件超过 100MB 上限（${bytes.length} 字节），请使用小文件或分批上传`);
    }
    const b64 = this.base64FromBytes(bytes);
    let sha: string | undefined;
    try {
      const meta = await this.fetchContentsMeta(repoPath);
      if (meta && !meta.dir && meta.sha) sha = meta.sha;
    } catch { /* 文件不存在则直接创建 */ }
    await this.ghJson(`/repos/${this.owner}/${this.repo}/contents/${this.encodePathInRepo(repoPath)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `上传 ${key.split("/").pop() || "文件"}`,
        content: b64,
        branch: this.branch,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  async deleteObject(key: string): Promise<void> {
    const repoPath = this.toRepoPath(key);
    const meta = await this.fetchContentsMeta(repoPath);
    if (!meta || meta.dir) return;
    await this.ghJson(`/repos/${this.owner}/${this.repo}/contents/${this.encodePathInRepo(repoPath)}`, {
      method: "DELETE",
      body: JSON.stringify({
        message: `删除 ${key.split("/").pop() || "文件"}`,
        branch: this.branch,
        sha: meta.sha,
      }),
    });
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = stripTrailingSlash(stripLeadingSlash(folderPath));
    if (!normalized) return;
    const fileName = normalized.split("/").pop() || ".gitkeep";
    const dir = normalized.split("/").slice(0, -1).join("/");
    const target = dir ? `${dir}/${fileName}` : fileName;
    await this.putObject(target, "", "application/octet-stream");
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const srcRepoPath = this.toRepoPath(sourceKey);
    const meta = await this.fetchContentsMeta(srcRepoPath);
    if (!meta || meta.dir) return;
    const srcEncoded = this.encodePathInRepo(srcRepoPath);
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/contents/${srcEncoded}?ref=${encodeURIComponent(this.branch)}`, {}, true);
    if (!res.ok) throw new Error(`GitHub copy: 源文件下载失败 ${res.status}`);
    const buf = await res.arrayBuffer();
    await this.putObject(destKey, buf, getMimeType(sourceKey) || "application/octet-stream");
  }

  async renameObject(path: string, _newName: string): Promise<void> {
    // GitHub 无法原地重命名：通过 copyObject + deleteObject 实现，由路由层兜底
    throw new Error("GitHub 暂不支持 rename，使用 copy + delete 实现");
  }
  async moveObject(_path: string, _newPath: string): Promise<void> {
    throw new Error("GitHub 暂不支持 move，使用 copy + delete 实现");
  }

  async initiateMultipartUpload(_key: string, _contentType: string, _options?: { size?: number; chunkSize?: number }): Promise<string> {
    throw new Error("GitHub 存储不支持分片上传（单文件最大 100MB）");
  }
  async uploadPart(): Promise<string> {
    throw new Error("GitHub 存储不支持分片上传");
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

  // ---- internal ----

  private async fetchContentsMeta(repoPath: string): Promise<{ sha: string; size: number; dir: boolean } | null> {
    const encoded = this.encodePathInRepo(repoPath);
    const url = encoded
      ? `/repos/${this.owner}/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(this.branch)}`
      : `/repos/${this.owner}/${this.repo}/contents?ref=${encodeURIComponent(this.branch)}`;
    const res = await this.gh(url);
    if (res.status === 404) return null;
    if (res.status === 403) {
      const text = await res.text();
      throw new Error(`GitHub API 权限不足: ${text}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    const entry = (await res.json()) as ContentsEntry | ContentsEntry[] | { message?: string };
    if (Array.isArray(entry) || (entry as { message?: string }).message) {
      return null;
    }
    const e = entry as ContentsEntry;
    return {
      sha: e.sha,
      size: e.size,
      dir: e.type === "dir",
    };
  }
}
