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

/** 分享密码哈希：PBKDF2-SHA256（100k 次迭代 + 随机盐）。旧的无盐 SHA-256 哈希仍可校验（向后兼容）。 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = "pbkdf2$";
// 密码长度上限：PBKDF2 计算成本随输入长度增长，防超大密码拖垮 Workers
const MAX_PASSWORD_LEN = 256;

function toBase64(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${toBase64(salt.buffer)}$${toBase64(bits)}`;
}

// 恒定时间比较，防时序侧信道
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith(PBKDF2_PREFIX)) {
    const [, iterStr, saltB64, hashB64] = stored.split("$");
    const iterations = parseInt(iterStr, 10) || PBKDF2_ITERATIONS;
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: fromBase64(saltB64), iterations, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return timingSafeEqualHex(toBase64(bits), hashB64);
  }
  // 旧格式：无盐 SHA-256（仅兼容存量分享，新分享不再使用）
  const hash = await sha256Hex(password);
  return timingSafeEqualHex(hash, stored);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
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
  const trimmedPassword = password?.trim() || "";
  if (trimmedPassword.length > MAX_PASSWORD_LEN) {
    throw new Error(`分享密码不能超过 ${MAX_PASSWORD_LEN} 个字符`);
  }
  const passwordHash = trimmedPassword ? await hashPassword(trimmedPassword) : null;

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
  // 超长密码直接拒绝，避免 PBKDF2 高成本计算被滥用（DoS）
  if (password.length > MAX_PASSWORD_LEN) return false;
  return verifyPassword(password, row.password_hash);
}

export async function deleteShare(db: D1Database, id: string): Promise<void> {
  const query = `DELETE FROM shares WHERE id = ?`;
  await db.prepare(query).bind(id).run();
}

export async function cleanExpiredShares(db: D1Database): Promise<void> {
  const query = `DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`;
  await db.prepare(query).run();
}
