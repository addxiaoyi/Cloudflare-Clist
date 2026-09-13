import type { GitConnection, GitPlatformAdapter, GitDirEntry, GitCommitMeta, GitFileStat } from "../types";
import { parseRepoSegments, encodedIdPath } from "../repo-ref";
import { base64FromBytes, describeError } from "../helpers";

const DEFAULT_BRANCH = "main";
const PAGE_SIZE = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface TreeItem { id: string; name: string; path: string; type: "blob" | "tree" | "commit" }
interface CommitLite { id: string; created_at: string }
interface FileMeta { last_commit_id: string; size: number }

function projectId(conn: GitConnection): string {
  return encodedIdPath(conn.repo);
}

function api(conn: GitConnection, path: string): string {
  return `${conn.apiBase}${path}`;
}

function withQuery(conn: GitConnection, path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return api(conn, `${path}${path.includes("?") ? "&" : "?"}${qs}`);
}

function encodeFilePath(repoPath: string): string {
  return encodeURIComponent(repoPath);
}

async function request(conn: GitConnection, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": conn.token,
      ...(init?.headers || {}),
    },
  });
}

async function json<T>(conn: GitConnection, url: string, init?: RequestInit): Promise<T> {
  const res = await request(conn, url, init);
  if (!res.ok) throw new Error(describeError("GitLab", res.status, await res.text()));
  if (res.status === 204) return {} as T;
  return res.json() as T;
}

async function rawBytes(conn: GitConnection, repoPath: string): Promise<ArrayBuffer> {
  const url = withQuery(conn, `/projects/${projectId(conn)}/repository/files/${encodeFilePath(repoPath)}/raw`, { ref: conn.branch });
  const res = await request(conn, url);
  if (res.status === 404) throw new Error(`GitLab 未找到文件：${repoPath}`);
  if (!res.ok) throw new Error(describeError("GitLab", res.status, await res.text()));
  return res.arrayBuffer();
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function mapType(t: TreeItem["type"]): GitDirEntry["type"] {
  return t === "tree" ? "dir" : t === "blob" ? "file" : "other";
}

export const gitlabAdapter: GitPlatformAdapter = {
  type: "gitlab",
  label: "GitLab",
  maxFileBytes: MAX_FILE_BYTES,
  maxFileLabel: "10MB",
  supportsListTree: true,

  buildConnection(config) {
    const cfg = config || {};
    const segs = parseRepoSegments(cfg.repo, /^gitlab\.com[:/]/i);
    if (!segs || segs.length < 2) throw new Error("GitLab 存储需填写项目路径（如 group/subgroup/project）");
    const token = typeof cfg.token === "string" && cfg.token ? cfg.token : "";
    if (!token) throw new Error("GitLab 存储需填写 Personal Access Token 或 Project Access Token");
    let rawApiBase = typeof cfg.api_base === "string" && cfg.api_base ? cfg.api_base : "https://gitlab.com";
    rawApiBase = rawApiBase.replace(/\/+$/, "");
    if (!/\/api\/v\d+$/.test(rawApiBase)) rawApiBase = `${rawApiBase}/api/v4`;
    const branch = typeof cfg.branch === "string" && cfg.branch ? cfg.branch : DEFAULT_BRANCH;
    const rootPath = typeof cfg.root_path === "string" ? cfg.root_path.replace(/^\/+/, "").replace(/\/+$/, "") : "";
    return { repo: segs, token, apiBase: rawApiBase, branch, rootPath };
  },

  async headCommit(conn) {
    const commits = await json<CommitLite[]>(conn, withQuery(conn, `/projects/${projectId(conn)}/repository/commits`, { ref_name: conn.branch, per_page: "1" }));
    const lite = commits[0];
    return { sha: lite?.id || "", date: lite?.created_at || new Date().toISOString() };
  },

  async ping(conn) {
    try {
      await this.headCommit(conn);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },

  async listDir(conn, repoPath, opts) {
    const params: Record<string, string> = { ref: conn.branch, per_page: String(PAGE_SIZE), pagination: "keyset" };
    if (repoPath) params.path = repoPath;
    if (opts.token) params.page = opts.token;
    let page = opts.token ? Number(opts.token) : 1;
    const entries: GitDirEntry[] = [];
    let nextToken: string | null = null;
    while (true) {
      const res = await request(conn, withQuery(conn, `/projects/${projectId(conn)}/repository/tree`, { ...params, page: String(page) }));
      if (res.status === 404) return entries.length ? { entries, nextToken } : null;
      if (!res.ok) throw new Error(describeError("GitLab", res.status, await res.text()));
      const items = (await res.json()) as TreeItem[];
      for (const e of items) {
        const t = mapType(e.type);
        if (t === "other") continue;
        entries.push({ name: e.name, path: e.path, sha: e.id, size: 0, type: t });
      }
      const next = res.headers.get("X-Next-Page");
      if (opts.maxItems && entries.length >= opts.maxItems) {
        nextToken = next;
        break;
      }
      if (!next) {
        nextToken = null;
        break;
      }
      page = Number(next);
    }
    return { entries, nextToken };
  },

  async listTree(conn) {
    const params: Record<string, string> = { ref: conn.branch, recursive: "true", per_page: String(PAGE_SIZE), pagination: "keyset" };
    let page = 1;
    const out: GitDirEntry[] = [];
    while (true) {
      const res = await request(conn, withQuery(conn, `/projects/${projectId(conn)}/repository/tree`, { ...params, page: String(page) }));
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(describeError("GitLab", res.status, await res.text()));
      const items = (await res.json()) as TreeItem[];
      for (const e of items) {
        if (e.type !== "blob") continue;
        out.push({ name: e.name, path: e.path, sha: e.id, size: 0, type: "file" });
      }
      const next = res.headers.get("X-Next-Page");
      if (!next) break;
      page = Number(next);
    }
    return out;
  },

  async statFile(conn, repoPath) {
    if (!repoPath) return null;
    const res = await request(conn, withQuery(conn, `/projects/${projectId(conn)}/repository/files/${encodeFilePath(repoPath)}`, { ref: conn.branch }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(describeError("GitLab", res.status, await res.text()));
    const meta = (await res.json()) as FileMeta;
    return { sha: meta.last_commit_id, size: meta.size };
  },

  async readFile(conn, repoPath) {
    const bytes = await rawBytes(conn, repoPath);
    return { bytes, size: bytes.byteLength };
  },

  async writeFile(conn, repoPath, bytes, message) {
    const existing = await this.statFile(conn, repoPath);
    const body = JSON.stringify({
      branch: conn.branch,
      content: base64FromBytes(bytes),
      encoding: "base64",
      commit_message: message,
    });
    if (existing) {
      await json(conn, api(conn, `/projects/${projectId(conn)}/repository/files/${encodeFilePath(repoPath)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } else {
      await json(conn, api(conn, `/projects/${projectId(conn)}/repository/files/${encodeFilePath(repoPath)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: conn.branch,
          content: base64FromBytes(bytes),
          encoding: "base64",
          commit_message: message,
          file_path: repoPath,
        }),
      });
    }
  },

  async deleteFile(conn, repoPath, message) {
    const existing = await this.statFile(conn, repoPath);
    if (!existing) return;
    await json(conn, withQuery(conn, `/projects/${projectId(conn)}/repository/files/${encodeFilePath(repoPath)}`, { branch: conn.branch, commit_message: message }), {
      method: "DELETE",
    });
  },

  signedUrl(conn, repoPath) {
    return withQuery(conn, `/projects/${projectId(conn)}/repository/files/${encodeFilePath(repoPath)}/raw`, { ref: conn.branch });
  },
};

function toCommitMeta(arr: { id: string; created_at: string }[]): GitCommitMeta {
  return { sha: arr[0]?.id || "", date: arr[0]?.created_at || new Date().toISOString() };
}