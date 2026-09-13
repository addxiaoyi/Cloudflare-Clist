import type { GitConnection, GitPlatformAdapter, GitDirEntry } from "../types";
import { parseRepoSegments, requireTwoSegments } from "../repo-ref";
import { encodePathRepo, base64FromBytes, describeError } from "../helpers";

const DEFAULT_BRANCH = "master";
const PAGE_SIZE = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface ContentsItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "tag" | "branch" | "commit" | "symlink";
  encoding?: "base64";
  content?: string;
}
interface BranchResp { commit?: { sha?: string; date?: string } }
interface CommitDetail { sha: string; commit_date?: string; created_at?: string; commit?: { author?: { date?: string } } }

function repoId(conn: GitConnection): string {
  return conn.repo.map(encodeURIComponent).join("/");
}

function api(conn: GitConnection, path: string): string {
  return `${conn.apiBase}${path}`;
}

function withAuth(conn: GitConnection, path: string, params: Record<string, string> = {}): string {
  const all = { access_token: conn.token, ...params };
  const qs = new URLSearchParams(all).toString();
  return api(conn, `${path}${path.includes("?") ? "&" : "?"}${qs}`);
}

async function request(conn: GitConnection, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers || {}) },
  });
}

async function json<T>(conn: GitConnection, url: string, init?: RequestInit): Promise<T> {
  const res = await request(conn, url, init);
  if (!res.ok) throw new Error(describeError("Gitee", res.status, await res.text()));
  return res.json() as T;
}

function toEntries(raw: ContentsItem[]): GitDirEntry[] {
  const out: GitDirEntry[] = [];
  for (const e of raw) {
    if (e.type === "dir") {
      out.push({ name: e.name, path: e.path, sha: e.sha, size: 0, type: "dir" });
    } else if (e.type === "file") {
      out.push({ name: e.name, path: e.path, sha: e.sha, size: e.size || 0, type: "file" });
    }
  }
  return out;
}

function bytesFromBase64(b64: string): Uint8Array {
  const compact = b64.replace(/\s+/g, "");
  const bin = atob(compact);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export const giteeAdapter: GitPlatformAdapter = {
  type: "gitee",
  label: "Gitee",
  maxFileBytes: MAX_FILE_BYTES,
  maxFileLabel: "10MB",
  supportsListTree: false,

  buildConnection(config) {
    const cfg = config || {};
    const segs = parseRepoSegments(cfg.repo, /^gitee\.com[:/]/i);
    const two = requireTwoSegments(segs);
    if (!two) throw new Error("Gitee 存储需填写仓库，支持 owner/repo 或完整仓库 URL");
    const token = typeof cfg.token === "string" && cfg.token ? cfg.token : "";
    if (!token) throw new Error("Gitee 存储需填写私人令牌（Personal Access Token）");
    let rawApiBase = typeof cfg.api_base === "string" && cfg.api_base ? cfg.api_base : "https://gitee.com/api/v5";
    rawApiBase = rawApiBase.replace(/\/+$/, "");
    if (!/\/api\/v\d+$/.test(rawApiBase)) rawApiBase = `${rawApiBase}/api/v5`;
    const branch = typeof cfg.branch === "string" && cfg.branch ? cfg.branch : DEFAULT_BRANCH;
    const rootPath = typeof cfg.root_path === "string" ? cfg.root_path.replace(/^\/+/, "").replace(/\/+$/, "") : "";
    return { repo: two, token, apiBase: rawApiBase, branch, rootPath };
  },

  async headCommit(conn) {
    const branch = await json<BranchResp>(conn, withAuth(conn, `/repos/${repoId(conn)}/branches/${encodeURIComponent(conn.branch)}`));
    const sha = branch?.commit?.sha;
    if (!sha) throw new Error(`Gitee 未找到分支：${conn.branch}`);
    if (branch?.commit?.date) return { sha, date: branch.commit.date };
    const detail = await json<CommitDetail>(conn, withAuth(conn, `/repos/${repoId(conn)}/commits/${sha}`));
    const date = detail?.commit?.author?.date || detail?.commit_date || detail?.created_at || new Date().toISOString();
    return { sha, date };
  },

  async ping(conn) {
    try { await this.headCommit(conn); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
  },

  async listDir(conn, repoPath, opts) {
    const encoded = repoPath ? `/${encodePathRepo(repoPath)}` : "";
    let page = opts.token ? Number(opts.token) : 1;
    const entries: GitDirEntry[] = [];
    let nextToken: string | null = null;
    while (true) {
      const url = withAuth(conn, `/repos/${repoId(conn)}/contents${encoded}`, {
        ref: conn.branch, page: String(page), per_page: String(PAGE_SIZE),
      });
      const res = await request(conn, url);
      if (res.status === 404) return entries.length ? { entries, nextToken } : null;
      if (!res.ok) throw new Error(describeError("Gitee", res.status, await res.text()));
      const raw = await res.json();
      if (!Array.isArray(raw)) {
        const item = raw as ContentsItem;
        entries.push(...toEntries([item]));
      } else {
        entries.push(...toEntries(raw as ContentsItem[]));
      }
      const items = Array.isArray(raw) ? (raw as ContentsItem[]) : [raw as ContentsItem];
      if (items.length < PAGE_SIZE) { nextToken = null; break; }
      if (opts.maxItems && entries.length >= opts.maxItems) { nextToken = String(page + 1); break; }
      page++;
    }
    return { entries, nextToken };
  },

  async listTree() {
    return null;
  },

  async statFile(conn, repoPath) {
    if (!repoPath) return null;
    const url = withAuth(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}`, { ref: conn.branch });
    const res = await request(conn, url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(describeError("Gitee", res.status, await res.text()));
    const parsed = await res.json();
    const arr = Array.isArray(parsed) ? (parsed as ContentsItem[]) : [parsed as ContentsItem];
    const item = arr[0];
    if (!item || item.type !== "file") return null;
    return { sha: item.sha, size: item.size || 0 };
  },

  async readFile(conn, repoPath) {
    const url = withAuth(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}`, { ref: conn.branch });
    const res = await request(conn, url);
    if (res.status === 404) throw new Error(`Gitee 未找到文件：${repoPath}`);
    if (!res.ok) throw new Error(describeError("Gitee", res.status, await res.text()));
    const parsed = await res.json();
    const arr = Array.isArray(parsed) ? (parsed as ContentsItem[]) : [parsed as ContentsItem];
    const item = arr[0];
    if (!item || item.type !== "file") throw new Error(`Gitee 未找到文件：${repoPath}`);
    const bytes = bytesFromBase64(item.content || "");
    return { bytes: bytes.buffer as ArrayBuffer, size: bytes.length };
  },

  async writeFile(conn, repoPath, bytes, message) {
    const s = await this.statFile(conn, repoPath);
    const [owner, repo] = conn.repo;
    const payload: Record<string, string> = {
      access_token: conn.token, owner, repo, path: repoPath,
      content: base64FromBytes(bytes), message, branch: conn.branch,
    };
    const url = api(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}`);
    if (s) {
      payload.sha = s.sha;
      await json(conn, url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } else {
      await json(conn, url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
  },

  async deleteFile(conn, repoPath, message) {
    const s = await this.statFile(conn, repoPath);
    if (!s) return;
    const [owner, repo] = conn.repo;
    const payload = { access_token: conn.token, owner, repo, path: repoPath, message, branch: conn.branch, sha: s.sha };
    await json(conn, api(conn, `/repos/${repoId(conn)}/contents/${encodePathRepo(repoPath)}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  signedUrl(conn, repoPath) {
    const [owner, repo] = conn.repo;
    return `https://gitee.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(conn.branch)}/${encodePathRepo(repoPath)}`;
  },
};