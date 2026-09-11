export interface Share {
  id: string;
  storageId: number;
  filePath: string;
  isDirectory: boolean;
  shareToken: string;
  expiresAt: string | null;
  createdAt: string;
  passwordHash: string | null;
}

interface ShareRow {
  id: string;
  storage_id: number;
  file_path: string;
  is_directory: number;
  share_token: string;
  expires_at: string | null;
  created_at: string;
  password_hash: string | null;
}

/** SHA-256 → hex，用于密码哈希（Cloudflare Workers Web Crypto） */
async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateRandomToken(length: number = 24): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const n = alphabet.length;
  // 256 无法整除 62，拒绝 >= limit 的字节以消除取模偏置，保证均匀分布
  const limit = 256 - (256 % n);
  let result = "";
  while (result.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte < limit) {
        result += alphabet[byte % n];
        if (result.length === length) {
          break;
        }
      }
    }
  }
  return result;
}

function generateShareId(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  const rand = [...buf].map((b) => b.toString(36).padStart(2, "0")).join("");
  return `share_${Date.now()}_${rand}`;
}

function validateShareToken(shareToken: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(shareToken)) {
    throw new Error("分享令牌只能包含字母、数字、下划线或短横线，长度 1-64 位");
  }
}

function rowToShare(row: ShareRow): Share | null {
  if (!row) return null;
  // 过期检查
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at);
    if (expiresAt < new Date()) {
      return null;
    }
  }
  return {
    id: row.id,
    storageId: row.storage_id,
    filePath: row.file_path,
    isDirectory: row.is_directory === 1,
    shareToken: row.share_token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  };
}

export async function shareTokenExists(db: D1Database, shareToken: string): Promise<boolean> {
  const result = await db
    .prepare(`SELECT id FROM shares WHERE share_token = ? LIMIT 1`)
    .bind(shareToken)
    .first<{ id: string }>();

  return result !== null;
}

export async function createShare(
  db: D1Database,
  storageId: number,
  filePath: string,
  isDirectory: boolean,
  expiresAt?: string,
  customShareToken?: string,
  password?: string
): Promise<Share> {
  const id = generateShareId();
  const shareToken = customShareToken?.trim() || generateRandomToken();
  const createdAt = new Date().toISOString();
  const passwordHash = password && password.trim() ? await hashPassword(password.trim()) : null;

  validateShareToken(shareToken);
  if (await shareTokenExists(db, shareToken)) {
    throw new Error("分享令牌已存在，请换一个");
  }

  const query = `
    INSERT INTO shares (id, storage_id, file_path, is_directory, share_token, expires_at, created_at, password_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await db.prepare(query).bind(id, storageId, filePath, isDirectory ? 1 : 0, shareToken, expiresAt || null, createdAt, passwordHash).run();

  return {
    id,
    storageId,
    filePath,
    isDirectory,
    shareToken,
    expiresAt: expiresAt || null,
    createdAt,
    passwordHash,
  };
}

export async function getShareByToken(db: D1Database, token: string): Promise<Share | null> {
  const result = await db.prepare(`SELECT * FROM shares WHERE share_token = ?`).bind(token).first<ShareRow>();
  if (!result) return null;
  return rowToShare(result);
}

export async function getShareById(db: D1Database, id: string): Promise<Share | null> {
  const result = await db.prepare(`SELECT * FROM shares WHERE id = ?`).bind(id).first<ShareRow>();
  if (!result) return null;
  return rowToShare(result);
}

export async function getAllShares(db: D1Database, storageId?: number): Promise<Share[]> {
  let query = `SELECT * FROM shares WHERE 1=1`;
  const bindings: (string | number)[] = [];

  if (storageId !== undefined) {
    query += ` AND storage_id = ?`;
    bindings.push(storageId);
  }

  query += ` ORDER BY created_at DESC`;

  const result = await db.prepare(query).bind(...bindings).all<ShareRow>();

  return (result.results || []).map((row) => rowToShare(row)).filter((s): s is Share => s !== null);
}

/** 校验访问密码：分享未设密码时返回 true；否则比对 SHA-256 */
export async function verifySharePassword(
  db: D1Database,
  token: string,
  password?: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT password_hash FROM shares WHERE share_token = ?`)
    .bind(token)
    .first<{ password_hash: string | null }>();

  if (!row) return false;
  if (!row.password_hash) return true; // 未设密码
  if (!password) return false;
  const hash = await hashPassword(password);
  return hash === row.password_hash;
}

export async function deleteShare(db: D1Database, id: string): Promise<void> {
  const query = `DELETE FROM shares WHERE id = ?`;
  await db.prepare(query).bind(id).run();
}

export async function cleanExpiredShares(db: D1Database): Promise<void> {
  const query = `DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`;
  await db.prepare(query).run();
}
