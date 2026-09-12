export type AuditUserType = "guest" | "admin" | "share";

export interface AuditLogEntry {
  action: string;
  storageId?: number | null;
  path?: string | null;
  userType?: AuditUserType;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | string | null;
}

export interface AuditLogRow {
  id: number;
  action: string;
  storageId: number | null;
  path: string | null;
  userType: AuditUserType;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
  createdAt: string;
}

function pickClientIp(request: Request): string | null {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0]?.trim() || null;
  const realIp = request.headers.get("X-Real-IP");
  if (realIp) return realIp;
  return null;
}

export function getRequestMeta(request: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: pickClientIp(request),
    userAgent: request.headers.get("User-Agent"),
  };
}

function normalizeDetail(detail: AuditLogEntry["detail"]): string | null {
  if (detail === undefined || detail === null) return null;
  if (typeof detail === "string") return detail.length > 2000 ? detail.slice(0, 2000) : detail;
  try {
    const json = JSON.stringify(detail);
    return json.length > 2000 ? json.slice(0, 2000) : json;
  } catch {
    return null;
  }
}

export async function logAudit(db: D1Database, entry: AuditLogEntry): Promise<void> {
  const detail = normalizeDetail(entry.detail);
  await db
    .prepare(
      `INSERT INTO audit_logs (action, storage_id, path, user_type, ip, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.action,
      entry.storageId ?? null,
      entry.path ?? null,
      entry.userType ?? "guest",
      entry.ip ?? null,
      entry.userAgent ?? null,
      detail
    )
    .run();
}

export async function getAuditLogs(
  db: D1Database,
  {
    limit = 200,
    offset = 0,
    action,
    storageId,
    userType,
  }: {
    limit?: number;
    offset?: number;
    action?: string;
    storageId?: number;
    userType?: AuditUserType;
  }
): Promise<AuditLogRow[]> {
  let query = `SELECT id, action, storage_id as storageId, path, user_type as userType, ip, user_agent as userAgent, detail, created_at as createdAt
               FROM audit_logs WHERE 1=1`;
  const bindings: Array<string | number> = [];

  if (action) {
    query += " AND action = ?";
    bindings.push(action);
  }
  if (typeof storageId === "number" && !Number.isNaN(storageId)) {
    query += " AND storage_id = ?";
    bindings.push(storageId);
  }
  if (userType) {
    query += " AND user_type = ?";
    bindings.push(userType);
  }

  query += " ORDER BY id DESC LIMIT ? OFFSET ?";
  bindings.push(limit, offset);

  const result = await db.prepare(query).bind(...bindings).all<AuditLogRow>();
  return result.results || [];
}

// 通用限流：统计某动作在时间窗口内同 IP 的失败次数，达到阈值则拒绝（登录/分享密码防爆破）
export async function isRateLimited(
  db: D1Database,
  ip: string | null,
  action: string,
  { windowMinutes = 15, maxFailures = 10 } = {}
): Promise<boolean> {
  if (!ip) return false;
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM audit_logs
       WHERE action = ? AND ip = ? AND created_at >= datetime('now', ?)`
    )
    .bind(action, ip, `-${windowMinutes} minutes`)
    .first<{ cnt: number }>();
  return (row?.cnt || 0) >= maxFailures;
}
