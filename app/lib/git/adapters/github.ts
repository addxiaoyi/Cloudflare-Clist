import { parseRepoSegments, requireTwoSegments } from "../repo-ref";
import { encodePathRepo, base64FromBytes, nextLinkUrl, rateLimitWait, describeError, decodeGitPath } from "../helpers";

const DEFAULT_BRANCH = "main";
const PAGE_SIZE = 100;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

interface ContentsEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule" | "other";
}
interface TreeEntry { path: string; type: "blob" | "tree" | "commit"; sha: string }
interface RefResp { object: { sha: string } }
interface CommitResp { commit: { author: { date: string } } }

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

async function request(
  conn: GitConnection,
  url: string,
  init?: RequestInit,
  rawMedia = false
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      Accept: rawMedia ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      ...(init?.headers || {}),
    },
  });
  const wait = rateLimitWait(res);
  if (wait !== null) throw new Error(`GitHub 触发限流，请 ${wait} 秒后重试（主限流配额约 5000 次/小时）`);
  return res;
}

async function json<T>(conn: GitConnection, url: string, init?: RequestInit): Promise<T> {
  const res = await request(conn, url, init);
  if (!res.ok) throw new Error(describeError("GitHub", res.status, await res.text()));
  if (res.status === 204) return {} as T;
  return res.json() as T;
}

function toEntries(raw: ContentsEntry[]): GitDirEntry[] {
  const out: GitDirEntry[] = [];
  for (const e of raw) {
    if (e.type === "symlink" || e.type === "submodule") continue;
    out.push({
      name: e.name,
      path: e.path,
      sha: e.sha,
      size: e.type === "file" ? e.size : 0,
      type: e.type === "dir" ? "dir" : "file",
    });
  }
  return out;
}

async function stat(conn: GitConnection, repoPath: string): Promise<GitFileStat | null> {
  const encoded = repoPath ? `/${encodePathRepo(repoPath)}` : "";
  const res = await request(conn, withQuery(conn, `/repos/${repoId(conn)}/contents${encoded}`, { ref: conn.branch }));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(describeError("GitHub", res.status, await res.text()));
  const entry = (await res.json()) as ContentsEntry | ContentsEntry[] | { message?: string };
  if (Array.isArray(entry) || (entry as { message?: string }).message) return null;
  const e = entry as ContentsEntry;
  if (e.type === "dir") return null;
  return { sha: e.sha, size: e.size };
}

async function blobRaw(conn: GitConnection, sha: string): Promise<ArrayBuffer> {
  const res = await request(conn, api(conn, `/repos/${repoId(conn)}/git/blobs/${sha}`), {}, true);
  if (!res.ok) throw new Error(describeError("GitHub", res.status, await res.text()));
  return res.arrayBuffer();
}

async function head(conn: GitConnection): Promise<GitCommitMeta> {
  const ref = await json<RefResp>(conn, withQuery(conn, `/repos/${repoId(conn)}/git/ref/heads/${encodeURIComponent(conn.branch)}`, {}));
  const commit = await json<CommitResp>(conn, api(conn, `/repos/${repoId(conn)}/git/commits/${ref.object.sha}`));
  return { sha: ref.object.sha, date: commit.commit.author.date };
}

export const githubAdapter: GitPlatformAdapter = {
  type: "github",
  label: "GitHub",
  maxFileBytes: MAX_FILE_BYTES,
  maxFileLabel: "100MB",
  supportsListTree: true,

  buildConnection(config) {
    const cfg = config || {};
    const ref = parseRepoSegments(cfg.repo, /^github\.com[:/]/i);
    const two = ref ? requireTwoSegments(ref) : null;
    if (!two) throw new Error("GitHub 存储需填写仓库，支持 owner/repo、完整仓库 URL、或含 .git 的形式");
    const token = typeof cfg.token === "string" && cfg.token ? cfg.token : "";
    if (!token) throw new Error("GitHub 存储需填写 Personal Access Token");
    const rawApiBase = typeof cfg.api_base === "string" && cfg.api_base ? cfg.api_base : "https://api.github.com";
    const apiBase = rawApiBase.replace(/\/+$/, "");
    const branch = typeof cfg.branch === "string" && cfg.branch ? cfg.branch : DEFAULT_BRANCH;
    const rootPath = typeof cfg.root_path === "string" ? cfg.root_path.replace(/^\/+/, "").replace(/\/+$/, "") : "";
    return { repo: two.segments, token, apiBase, branch, rootPath };
  },

  async ping(conn) {
    try {
      await head(conn);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },

  headCommit: (conn) => head(conn),

  async listDir(conn, repoPath, opts) {
    const encoded = repoPath ? `/${encodePathRepo(repoPath)}` : "";
    const base = withQuery(conn, `/repos/${repoId(conn)}/contents${encoded}`, {
      ref: conn.branch,
      per_page: String(PAGE_SIZE),
    });
    let url = opts.token || base;
    const entries: GitDirEntry[] = [];
    let nextToken: string | null = null;
    while (true) {
      const res = await request(conn, url);
      if (res.status === 404) return entries.length ? { entries, nextToken: null } : null;
      if (!res.ok) throw new Error(describeError("GitHub", res.status, await res.text()));
      const raw = await res.json();
      if (!Array.isArray(raw)) return entries.length ? { entries, nextToken: null } : null;
      entries.push(...toEntries(raw as ContentsEntry[]));
      const next = nextLinkUrl(res.headers.get("Link"));
      if (opts.maxItems && entries.length >= opts.maxItems) {
        nextToken = next;
        break;
      }
      if (!next) {
        nextToken = null;
        break;
      }
      url = next;
    }
    return { entries, nextToken };
  },

  async listTree(conn) {
    const { sha } = await head(conn);
    const res = await request(conn, api(conn, `/repos/${repoId(conn)}/git/trees/${sha}?recursive=1`));
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(describeError("GitHub", res.status, await res.text()));
    const tree = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
    if (tree.truncated) {
      throw new Error("GitHub 仓库条目过多，Git Trees 递归列表被截断（>7 万个条目）。请改用目录遍历或精简仓库");
    }
    const out: GitDirEntry[] = [];
    for (const e of tree.tree) {
      if (e.type !== "blob") continue;
      out.push({ name: e.path.split("/").pop() || e.path, path: decodeGitPath(e.path), sha: e.sha, size: 0, type: "file" });
    }
    return out;
  },

  statFile: (conn, repoPath) => stat(conn, repoPath),

  async readFile(conn, repoPath) {
    const s = await stat(conn, repoPath);
    if (!s) throw new Error(`GitHub 未找到文件：${repoPath}`);
    const bytes = await blobRaw(conn, s.sha);
    return { bytes, size: bytes.byteLength };
  },

  async writeFile(conn, repoPath, bytes, message) {
    const encoded = encodePathRepo(repoPath);
    let sha: string | undefined;
    const s = await stat(conn, repoPath);
    if (s) sha = s.sha;
    await json(conn, api(conn, `/repos/${repoId(conn)}/contents/${encoded}`), {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: base64FromBytes(bytes),
        branch: conn.branch,
        ...(sha ? { sha } : {}),
      }),
    });
  },

  async deleteFile(conn, repoPath, message) {
    const encoded = encodePathRepo(repoPath);
    const s = await stat(conn, repoPath);
    if (!s) return;
    await json(conn, api(conn, `/repos/${repoId(conn)}/contents/${encoded}`), {
      method: "DELETE",
      body: JSON.stringify({ message, branch: conn.branch, sha: s.sha }),
    });
  },

  signedUrl(conn, repoPath) {
    const encoded = encodePathRepo(repoPath);
    return api(conn, `/repos/${repoId(conn)}/contents/${encoded}?ref=${encodeURIComponent(conn.branch)}`);
  },
};
