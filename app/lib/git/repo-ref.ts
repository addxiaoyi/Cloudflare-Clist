// 从多种书写形式提取仓库路径段：
//   "owner/repo"
//   "https://host/owner/repo"
//   "git@host:owner/repo.git"
//   "group/sub/project"（GitLab 支持多级命名空间）
// hostPattern 决定剥离哪个域名；不匹配域名的首段会被当作 owner 保留。
export function parseRepoSegments(
  input: unknown,
  hostPattern: RegExp,
): string[] | null {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) return null;
  const cleaned = s
    .replace(/^(?:https?:\/\/|git@|ssh:\/\/)/i, "")
    .replace(hostPattern, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/i, "");
  const segments = cleaned
    .split("/")
    .map((seg) => decodeURIComponent(seg.trim()))
    .filter((seg) => seg.length > 0);
  if (segments.length < 2) return null;
  return segments;
}

// GitHub / Gitea / Gitee 只接受 owner/repo 两段；多或少都判为无效。
export function requireTwoSegments(segments: string[] | null): string[] | null {
  if (!segments || segments.length !== 2) return null;
  return segments;
}

// GitLab 用 URL 编码后的 "group%2Fsub%2Fproject" 作为 API 中的项目标识。
export function encodedIdPath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("%2F");
}

// 直接拼进路径的 owner/repo（GitHub 风格）。
export function plainIdPath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}
