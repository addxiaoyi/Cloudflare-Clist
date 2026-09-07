export type UserRole = "guest" | "admin";

export interface Session {
  id: string;
  userType: UserRole;
  expiresAt: Date;
}

// 默认会话时长：7 天（原本 24 小时，用户频繁掉线）
export const SESSION_DEFAULT_HOURS = 24 * 7;
// “记住我”会话时长：30 天
export const SESSION_REMEMBER_HOURS = 24 * 30;
// 剩余有效期低于一半时滑动续期
const RENEW_THRESHOLD_HALF = 0.5;

export function generateSessionId(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSession(
  db: D1Database,
  userType: UserRole,
  expiresInHours: number = SESSION_DEFAULT_HOURS
): Promise<string> {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  await db
    .prepare(
      "INSERT INTO sessions (id, user_type, expires_at) VALUES (?, ?, ?)"
    )
    .bind(sessionId, userType, expiresAt.toISOString())
    .run();

  return sessionId;
}

export async function getSession(
  db: D1Database,
  sessionId: string
): Promise<Session | null> {
  // 统一用 JS 生成的 ISO 字符串比较，避免与 SQLite datetime('now') 的
  // 混合格式做字符串比较带来的边界问题（同日过期会话可能被误判有效）
  const now = new Date().toISOString();
  const result = await db
    .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(sessionId, now)
    .first<{ id: string; user_type: string; expires_at: string }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    userType: result.user_type as UserRole,
    expiresAt: new Date(result.expires_at),
  };
}

// 滑动续期：把会话有效期顺延一个周期。由调用方按剩余时长决定是否执行。
export async function renewSession(
  db: D1Database,
  sessionId: string,
  expiresInHours: number = SESSION_DEFAULT_HOURS
): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  await db
    .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
    .bind(expiresAt.toISOString(), sessionId)
    .run();
}

// 剩余有效期是否低于一半（低于则建议滑动续期）
export function shouldRenewSession(
  session: Session,
  expiresInHours: number = SESSION_DEFAULT_HOURS
): boolean {
  const remainMs = session.expiresAt.getTime() - Date.now();
  const totalMs = expiresInHours * 60 * 60 * 1000;
  return remainMs < totalMs * RENEW_THRESHOLD_HALF;
}

export async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function cleanExpiredSessions(db: D1Database): Promise<void> {
  // 与 getSession 同款比较方式，保持格式一致
  const now = new Date().toISOString();
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
}

export function getSessionIdFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=");
    if (name === "session") {
      return value;
    }
  }
  return null;
}

export function createSessionCookie(
  sessionId: string,
  maxAge: number = 86400,
  secure: boolean = true
): string {
  // 生产环境 HTTPS 必须 Secure；http 下的 localhost/开发环境去掉 Secure，
  // 否则浏览器（尤其非 Chrome 内核）会直接拒收该 cookie 导致登录态丢失
  return `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${maxAge}`;
}

export function deleteSessionCookie(): string {
  return "session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0";
}

export async function validateAdmin(
  username: string,
  password: string,
  env: { ADMIN_USERNAME: string; ADMIN_PASSWORD: string }
): Promise<boolean> {
  return username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD;
}

export async function requireAuth(
  request: Request,
  db: D1Database,
  requiredRole: UserRole = "guest"
): Promise<{ session: Session | null; isAdmin: boolean }> {
  const cookieHeader = request.headers.get("Cookie");
  const sessionId = getSessionIdFromCookie(cookieHeader);

  if (!sessionId) {
    return { session: null, isAdmin: false };
  }

  const session = await getSession(db, sessionId);
  if (!session) {
    return { session: null, isAdmin: false };
  }

  const isAdmin = session.userType === "admin";

  if (requiredRole === "admin" && !isAdmin) {
    return { session, isAdmin: false };
  }

  return { session, isAdmin };
}
