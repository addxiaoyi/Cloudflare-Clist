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

// Git core.quotePath 简易转义表：\\"t → \t, \\n → \n 等；八进制 \nnn 在 decodeTreePath 里逐位处理。
const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, r: 0x0d,
  f: 0x0c, v: 0x0b, "\\": 0x5c, '"': 0x22,
};

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

  // Git Trees / Blobs 等底层 API 默认按 core.quotePath 输出：非 ASCII、控制字符、
  // 引号、反斜杠等会被包成 "..." 并用八进制转义（如 文档.txt → "\346\226\207\346\241\243.txt"）。
  // 递归列表拿到的 path 必须还原成真实 UTF-8，否则与 Contents API 的 key 对不齐，
  // 前缀匹配和后续按 key 读写的操作都会错乱。
  private decodeTreePath(raw: string): string {
    if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
    const inner = raw.slice(1, -1);
    if (inner.indexOf("\\") === -1) return inner;
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch !== "\\") {
        bytes.push(inner.charCodeAt(i));
        continue;
      }
      const next = inner[++i];
      if (next === undefined) break;
      const simple = SIMPLE_ESCAPES[next];
      if (simple !== undefined) {
        bytes.push(simple);
        continue;
      }
      if (next >= "0" && next <= "7") {
        let oct = next;
        while (oct.length < 3 && i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
          oct += inner[++i];
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        continue;
      }
      // 未知转义按字面保留，避免吞字符
      bytes.push(next.charCodeAt(0));
    }
    return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
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
    }).then((res) => {
      // 主限流走 403（可能只带 X-RateLimit-Remaining: 0 而无 Retry-After），二级/滥用限流走 429
      const retryAfter = res.headers.get("Retry-After");
      const rateLimitExhausted = res.headers.get("X-RateLimit-Remaining") === "0";
      const isRateLimited = res.status === 429 || (res.status === 403 && (rateLimitExhausted || retryAfter !== null));
      if (isRateLimited) {
        const waitSec = parseInt(retryAfter || "60", 10);
        throw new Error(`GitHub 触发限流，请 ${waitSec} 秒后重试（主限流配额约 5000 次/小时）`);
      }
      return res;
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

  // 分页拉取目录；nextUrl 非空表示后续还有页码未拉取
  private async fetchDirectory(
    repoPath: string,
    maxItems?: number,
    continuationUrl?: string
  ): Promise<{ entries: ContentsEntry[]; nextUrl: string | null } | null> {
    let url: string;
    if (continuationUrl) {
      url = continuationUrl;
    } else {
      const encoded = repoPath ? `/${this.encodePathInRepo(repoPath)}` : "";
      url = `${this.apiBase}/repos/${this.owner}/${this.repo}/contents${encoded}?ref=${encodeURIComponent(this.branch)}&per_page=${CONTENTS_PAGE_SIZE}`;
    }
    const entries: ContentsEntry[] = [];
    let nextUrl: string | null = null;
    while (true) {
      const res = await this.requestWithHeaders(url);
      if (res.status === 404) {
        if (entries.length > 0) break;
        return null;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(this.describeApiError(res.status, text));
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) {
        if (entries.length > 0) break;
        return null;
      }
      entries.push(...(raw as ContentsEntry[]));
      nextUrl = GithubClient.nextLinkUrl(res.headers.get("Link"));
      if (!nextUrl) break;
      if (maxItems && entries.length >= maxItems) break;
      url = nextUrl;
    }
    return { entries, nextUrl };
  }

  private async fetchTreeRecursive(): Promise<GitTree | null> {
    const { sha } = await this.resolveHead();
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/git/trees/${sha}?recursive=1`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.describeApiError(res.status, text));
    }
    const tree = (await res.json()) as GitTree;
    // 还原 core.quotePath，统一使用真实 UTF-8 路径；目录条目和 blob 条目都要处理
    tree.tree = tree.tree.map((entry) => ({ ...entry, path: this.decodeTreePath(entry.path) }));
    return tree;
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
    maxKeys = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    const repoPath = this.toRepoPath(prefix);

    if (delimiter === "/") {
      const result = await this.fetchDirectory(repoPath, maxKeys > 0 ? maxKeys : undefined, continuationToken);
      if (!result) {
        return { objects: [], prefixes: [], isTruncated: false };
      }
      const { date } = await this.resolveHead();
      const objects: DriveObject[] = [];
      const prefixes: string[] = [];
      for (const item of result.entries) {
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
      // 还有下一页时把绝对 URL 作为不透明 token 交给上层 do-while 继续拉取
      return { objects, prefixes, isTruncated: result.nextUrl !== null, nextContinuationToken: result.nextUrl ?? undefined };
    }

    // Recursive / bulk mode (delimiter != "/") — return blobs only
    const tree = await this.fetchTreeRecursive();
    if (!tree) {
      return { objects: [], prefixes: [], isTruncated: false };
    }
    if (tree.truncated) {
      // 递归 tree 超过 GitHub 7 万条目上限会被截断且无续页接口；静默漏文件会引发批量删除/重命名丢数据，必须显式失败
      throw new Error("GitHub 仓库条目过多，Git Trees 递归列表被截断（>7 万个条目）。请改用目录遍历或精简仓库");
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
    return { objects, prefixes: [], isTruncated: false };
  }

  // 按 blob sha 取原始内容：Git Blobs API 支持到 100MB，绕开 Contents API 的 1MB 限制；
  // sha 为十六进制串，无路径分段编码问题
  private async fetchBlobRaw(sha: string): Promise<ArrayBuffer> {
    const res = await this.gh(`/repos/${this.owner}/${this.repo}/git/blobs/${sha}`, {}, true);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.describeApiError(res.status, text));
    }
    return res.arrayBuffer();
  }

  async getObject(key: string, options?: { range?: string }): Promise<Response> {
    const repoPath = this.toRepoPath(key);
    const meta = await this.fetchContentsMeta(repoPath);
    if (!meta) throw new Error(`GitHub 未找到文件：${key}`);
    const { sha, dir } = meta;
    if (dir) throw new Error(`GitHub 路径为目录而非文件：${key}`);
    if (!sha) throw new Error(`GitHub 文件元信息不完整：${key}`);

    const buf = await this.fetchBlobRaw(sha);
    const sizeBytes = buf.byteLength;
    const contentType = getMimeType(key) || "application/octet-stream";

    if (options?.range) {
      const range = this.parseRange(options.range, sizeBytes);
      if (range) {
        const part = buf.slice(range.start, range.end + 1);
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
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(sizeBytes),
          "Accept-Ranges": "bytes",
        },
      });
    }

    return new Response(buf, {
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
      const sizeMB = Math.round(bytes.length / (1024 * 1024) * 100) / 100;
      throw new Error(`GitHub 文件超过 100MB 上限（${sizeMB} MB），请使用小文件或分批上传`);
    }
    const fileName = key.split("/").pop() || "文件";
    const b64 = this.base64FromBytes(bytes);
    let sha: string | undefined;
    const meta = await this.fetchContentsMeta(repoPath);
    if (meta && !meta.dir && meta.sha) sha = meta.sha;
    await this.ghJson(`/repos/${this.owner}/${this.repo}/contents/${this.encodePathInRepo(repoPath)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `上传 ${fileName}`,
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
    if (existing && existing.entries.length > 0) return;
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
    if (!res.ok) {
      const text = await res.text();
      throw new Error(this.describeApiError(res.status, text));
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
