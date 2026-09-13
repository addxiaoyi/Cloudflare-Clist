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
// GitHub Contents API 单目录单次返回上限 1000 条，但每页最大 per_page 为 100
const CONTENTS_PAGE_SIZE = 100;
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

  static parseRepo(input: unknown): { owner: string; repo: string } | null {
    const s = typeof input === "string" ? input.trim() : "";
    if (!s) return null;
    const cleaned = s
      .replace(/^(?:https?:\/\/|git@)/i, "")
      .replace(/^github\.com[:/]/i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/i, "");
    const m = /^([^/]+)\/([^/]+)$/.exec(cleaned);
    if (!m) return null;
    const owner = m[1].trim();
    const repo = m[2].trim();
    if (!owner || !repo) return null;
    return { owner, repo };
  }

  constructor(options: { config?: Record<string, any>; saving?: Record<string, any> }) {
    const cfg = options.config || {};
    this.config = options.config;
    this.saving = options.saving;

    const parsed = GithubClient.parseRepo(cfg.repo);
    if (!parsed) {
      throw new Error("GitHub 存储需填写仓库，支持 owner/repo、完整仓库 URL、或含 .git 的形式");
    }
    this.owner = parsed.owner;
    this.repo = parsed.repo;

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

  // 提取 GitHub 分页 Link 头中 rel="next" 的绝对 URL；若已到末页返回 null
  static nextLinkUrl(header: string | null): string | null {
    if (!header) return null;
    const parts = header.split(",");
    for (const raw of parts) {
      const m = /<([^>]+)>;\s*rel="next"/i.exec(raw.trim());
      if (m) return m[1];
    }
    return null;
  }

  private requestWithHeaders(url: string, init?: RequestInit, rawMedia = false): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: rawMedia ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        ...(init?.headers || {}),
      },
    });
  }

  private async gh(path: string, init?: RequestInit, rawMedia = false): Promise<Response> {
    return this.requestWithHeaders(`${this.apiBase}${path}`, init, rawMedia);
  }

  private describeApiError(status: number, body: string): string {
    if (status === 401) return "GitHub 认证失败（401）：Token 无效或已过期，请检查 Personal Access Token";
    if (status === 403) {
      const hint = /rate limit/i.test(body) ? "请等待后重试或提高配额" : "请确认 Token 已授权 Contents 读写权限";
      return `GitHub 访问被拒（403）：${hint}`;
    }
    if (status === 404) return "GitHub 未找到目标（404）：仓库、分支或路径可能不存在，请确认仓库格式为 owner/repo 且分支正确";
    if (status === 422) return `GitHub 校验失败（422）：${body || "请求体不合法，常见于路径或 base64 编码异常"}`;
    return `GitHub API error: ${status} ${body}`;
  }

  private async ghJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.gh(path, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.describeApiError(res.status, text));
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

  // 每次写操作都会产生新提交，缓存的 HEAD 会立刻过期
  private invalidateHeadCache(): void {
    this.headSha = "";
    this.commitDate = "";
  }

  private async fetchDirectory(repoPath: string, collectAll = false, maxItems?: number): Promise<ContentsEntry[] | null> {
    const encoded = repoPath ? `/${this.encodePathInRepo(repoPath)}` : "";
    const query = `?ref=${encodeURIComponent(this.branch)}${collectAll ? `&per_page=${CONTENTS_PAGE_SIZE}` : ""}`;
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/contents${encoded}${query}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.describeApiError(res.status, text));
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) {
      return null;
    }
    const items = raw as ContentsEntry[];
    // 目录内容超出一页：跟随 Link 头 rel="next" 聚合，保证大目录不丢项
    let nextUrl = GithubClient.nextLinkUrl(res.headers.get("Link"));
    while (nextUrl) {
      // 超过上限则提前停止，避免拉取不必要的数据
      if (maxItems && items.length >= maxItems) break;
      const pageRes = await this.requestWithHeaders(nextUrl);
      if (!pageRes.ok) {
        const text = await pageRes.text();
        throw new Error(this.describeApiError(pageRes.status, text));
      }
      const pageRaw = await pageRes.json();
      if (!Array.isArray(pageRaw)) break;
      items.push(...(pageRaw as ContentsEntry[]));
      nextUrl = GithubClient.nextLinkUrl(pageRes.headers.get("Link"));
    }
    if (maxItems) {
      return items.slice(0, maxItems);
    }
    return items;
  }

  private async fetchTreeRecursive(): Promise<GitTree | null> {
    const { sha } = await this.resolveHead();
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/git/trees/${sha}?recursive=1`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.describeApiError(res.status, text));
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
      const items = await this.fetchDirectory(repoPath, true, _maxKeys > 0 ? _maxKeys : undefined);
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
      // GitHub Contents API 拉取时已决定是否拉完或止于 maxKeys；若 items 超过 maxKeys 说明被截断
      const isTruncated = _maxKeys > 0 && items.length >= _maxKeys;
      return { objects, prefixes, isTruncated };
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
    this.invalidateHeadCache();
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
    this.invalidateHeadCache();
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = stripTrailingSlash(stripLeadingSlash(folderPath));
    if (!normalized) return;
    // Git 不存空目录，用 .gitkeep 占位；已有内容则不重复塞占位文件
    const existing = await this.fetchDirectory(this.toRepoPath(normalized));
    if (existing && existing.length > 0) return;
    await this.putObject(`${normalized}/.gitkeep`, "", "application/octet-stream");
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const srcRepoPath = this.toRepoPath(sourceKey);
    const meta = await this.fetchContentsMeta(srcRepoPath);
    // 静默返回会让上层的 copy + delete 回退在源缺失时误删数据，这里必须显式失败
    if (!meta) throw new Error("GitHub copy: 源文件不存在");
    if (meta.dir) throw new Error("GitHub copy: 不支持复制目录对象，请逐文件复制");
    const srcEncoded = this.encodePathInRepo(srcRepoPath);
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/contents/${srcEncoded}?ref=${encodeURIComponent(this.branch)}`, {}, true);
    if (!res.ok) throw new Error(`GitHub copy: 源文件下载失败 ${res.status}`);
    const buf = await res.arrayBuffer();
    await this.putObject(destKey, buf, getMimeType(sourceKey) || "application/octet-stream");
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
