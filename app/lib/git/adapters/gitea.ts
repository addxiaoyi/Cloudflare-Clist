import type { GitConnection, GitPlatformAdapter, GitDirEntry } from "../types";
import { parseRepoSegments, requireTwoSegments } from "../repo-ref";
import { encodePathRepo, base64FromBytes, nextLinkUrl, rateLimitWait, describeError, decodeGitPath } from "../helpers";

const DEFAULT_BRANCH = "main";
const PAGE_SIZE = 100;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

interface ContentsItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink";
  mode?: string;
}
interface TreeItem { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number }
interface RefResp { object: { sha: string } }
interface CommitResp { sha: string; commit: { author: { date: string } } }
interface BlobResp { content: string; encoding: "base64" }

function repoId(conn: GitConnection): string {
  return conn.repo.map(encodeURIComponent).join("/");
}

function api(conn: GitConnection, path: string): string {
  return `${conn.apiBase}${path}`;
}

function withQuery(conn: GitConnection, path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return api(conn, `${path}${path.includes("?") ? "&" : "?"}${qs}`);
}

async function request(conn: GitConnection, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `token ${conn.token}`,
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  const wait = rateLimitWait(res);
  if (wait !== null) throw new Error(`Gitea 触发限流，请 ${wait} 秒后重试`);
  return res;
}

async function json<T>(conn: GitConnection, url: string, init?: RequestInit): Promise<T> {
  const res = await request(conn, url, init);
  if (!res.ok) throw new Error(describeError("Gitea", res.status, await res.text()));
  if (res.status === 204) return {} as T;
  return res.json() as T;
}

function toEntries(raw: ContentsItem[]): GitDirEntry[] {
  const out: GitDirEntry[] = [];
  for (const e of raw) {
    if (e.type === "symlink") continue;
    const type = e.type === "dir" ? "dir" : "file";
    out.push({ name: e.name, path: e.path, sha: e.sha, size: e.type === "file" ? e.size : 0, type });
  }
  return out;
}

export const giteaAdapter: GitPlatformAdapter = {
  type: "gitea",
  label: "Gitea",
  maxFileBytes: MAX_FILE_BYTES,
  maxFileLabel: "100MB",
  supportsListTree: true,

  buildConnection(config) {
    const cfg = config || {};
    const segs = parseRepoSegments(cfg.repo, /(?:codeberg\.org|gitea\.com)[:/]/i);
    const two = requireTwoSegments(segs);
    if (!two) throw new Error("Gitea 存储需填写仓库，支持 owner/repo 或完整仓库 URL");
    const token = typeof cfg.token === "string" && cfg.token ? cfg.token : "";
    if (!token) throw new Error("Gitea 存储需填写 Access Token");
    let rawApiBase = typeof cfg.api_base === "string" && cfg.api_base ? cfg.api_base : "https://gitea.com";
    rawApiBase = rawApiBase.replace(/\/+$/, "");
    if (!/\/api\/v\d+$/.test(rawApiBase)) rawApiBase = `${rawApiBase}/api/v1`;
    const branch = typeof cfg.branch === "string" && cfg.branch ? cfg.branch : DEFAULT_BRANCH;
    const rootPath = typeof cfg.root_path === "string" ? cfg.root_path.replace(/^\/+/, "").replace(/\/+$/, "") : "";
    return { repo: two, token, apiBase: rawApiBase, branch, rootPath };
  },

  async headCommit(conn) {
    const ref = await json<RefResp>(conn, withQuery(conn, `/repos/${repoId(conn)}/git/refs/heads/${encodeURIComponent(conn.branch)}`, {}));
    const commit = await json<CommitResp>(conn, api(conn, `/repos/${repoId(conn)}/git/commits/${ref.object.sha}`));
    return { sha: ref.object.sha, date: commit.commit.author.date };
  },

  async ping(conn) {
    try { await this.headCommit(conn); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
  },

  async listDir(conn, repoPath, opts) {
    const encoded = repoPath ? `/${encodePathRepo(repoPath)}` : "";
    const base = withQuery(conn, `/repos/${repoId(conn)}/contents${encoded}`, { ref: conn.branch, page: "1", limit: String(PAGE_SIZE) });
    let url = opts.token || base;
    const entries: GitDirEntry[] = [];
    let nextToken: string | null = null;
    while (true) {
      const res = await request(conn, url);
      if (res.status === 404) return entries.length ? { entries, nextToken: null } : null;
      if (!res.ok) throw new Error(describeError("Gitea", res.status, await res.text()));
      const raw = await res.json();
      if (!Array.isArray(raw)) return entries.length ? { entries, nextToken: null } : null;
      entries.push(...toEntries(raw as ContentsItem[]));
      const next = nextLinkUrl(res.headers.get("Link"));
      if (opts.maxItems && entries.length >= opts.maxItems) {
        nextToken = next;
        break;
      }
      if (!next) { nextToken = null; break; }
      url = next;
    }
    return { entries, nextToken };
  },

  async listTree(conn) {
    const meta = await this.headCommit(conn);
    const res = await request(conn, api(conn, `/repos/${repoId(conn)}/git/trees/${meta.sha}?recursive=true`));
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(describeError("Gitea", res.status, await res.text()));
    const tree = (await res.json()) as { truncated?: boolean; tree: TreeItem[] };
    if (tree.truncated) throw new Error("Gitea 仓库条目过多，Git Trees 递归列表被截断");
    const out: GitDirEntry[] = [];
    for (const e of tree.tree) {
      if (e.type !== "blob") continue;
      out.push({ name: e.path.split("/").pop() || e.path, path: decodeGitPath(e.path), sha: e.sha, size: e.size || 0, type: "file" });
    }
    return out;
  },

  async statFile(conn, repoPath) {
    const encoded = repoPath ? `/${encodePathRepo(repoPath)}` : "";
    const res = await request(conn, withQuery(conn, `/repos/${repoId(conn)}/contents${encoded}`, { ref: conn.branch }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(describeError("Gitea", res.status, await res.text()));
    const entry = await res.json();
    if (Array.isArray(entry) || entry.type === "dir") return null;
    const e = entry as ContentsItem;
    return { sha: e.sha, size: e.size };
  },

  async readFile(conn, repoPath) {
    const s = await this.statFile(conn, repoPath);
    if (!s) throw new Error(`Gitea 未找到文件：${repoPath}`);
    const res = await request(conn, api(conn, `/repos/${repoId(conn)}/git/blobs/${s.sha}`));
    if (!res.ok) throw new Error(describeError("Gitea", res.status, await res.text()));
    const blob = (await res.json()) as BlobResp;
    const bytes = Uint8Array.from(atob(blob.content), c => c.charCodeAt(0));
    return { bytes: bytes.buffer as ArrayBuffer, size: bytes.length };
  },

  async writeFile(conn, repoPath, bytes, message) {
    const s = await this.statFile(conn, repoPath);
    const payload = { message, content: base64FromBytes(bytes), branch: conn.branch, ...(s ? { sha: s.sha } : {}) };
    await json(conn, api(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  async deleteFile(conn, repoPath, message) {
    const s = await this.statFile(conn, repoPath);
    if (!s) return;
    await json(conn, api(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, branch: conn.branch, sha: s.sha }),
    });
  },

  signedUrl(conn, repoPath) {
    return api(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}?ref=${encodeURIComponent(conn.branch)}`);
  },
};