// Git core.quotePath 简易转义表，回退处理八进制转义。
const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, r: 0x0d,
  f: 0x0c, v: 0x0b, "\\": 0x5c, '"': 0x22,
};

export function decodeGitPath(raw: string): string {
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
    bytes.push(next.charCodeAt(0));
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

export function encodePathRepo(repoPath: string): string {
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

export function base64FromBytes(bytes: Uint8Array | ArrayBuffer): string {
  let bin = "";
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function nextLinkUrl(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/i.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/** 限流检测：返回等待秒数，未限流返回 null。 */
export function rateLimitWait(res: Response): number | null {
  const retryAfter = res.headers.get("Retry-After");
  if (res.status === 429) {
    const sec = parseInt(retryAfter || "60", 10);
    return Number.isFinite(sec) ? sec : 60;
  }
  if (res.status === 403) {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining === "0" && retryAfter) {
      return parseInt(retryAfter, 10) || 60;
    }
  }
  return null;
}

export function describeError(platformLabel: string, status: number, body: string): string {
  if (status === 401) return `${platformLabel} 认证失败（401）：Token 无效或已过期`;
  if (status === 403) {
    const hint = /rate limit/i.test(body) ? "触发限流，请稍后重试" : "Token 缺少所需权限";
    return `${platformLabel} 访问被拒（403）：${hint}`;
  }
  if (status === 404) return `${platformLabel} 未找到目标（404）：仓库、分支或路径不存在`;
  if (status === 422) return `${platformLabel} 校验失败（422）：${body || "请求体不合法"}`;
  return `${platformLabel} API 错误：${status} ${body}`;
}

/** 与 repoPath 类似的 decode（若某 adapter 不需要 quotePath，可直接返回原值）。 */
export const identityDecode = (v: string) => v;
