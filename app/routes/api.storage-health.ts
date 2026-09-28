import type { Route } from './+types/api.storage-health';
import {
  getAllStorages,
  getStorageById,
  initDatabase,
  type Storage,
} from '~/lib/storage';
import { requireAuth } from '~/lib/auth';
import { createClient } from '~/lib/client-factory';

// 授权健康检测：对每个存储做一次轻量 listObjects('')，据此判断凭据是否还有效。
// OAuth 类存储（gdrive/onedrive 等）令牌失效时会在这里抛错，便于管理员提前发现。

const CHECK_TIMEOUT_MS = 10_000;
// MySQL 走 Hyperdrive 直连，不适用 createClient，跳过检测
const SKIP_TYPES = new Set(['mysql']);

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('检测超时，请检查网络或凭据')),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface CheckResult {
  id: number;
  name: string;
  type: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

async function checkStorage(storage: Storage, env: Env): Promise<CheckResult> {
  const base = { id: storage.id, name: storage.name, type: storage.type };
  if (SKIP_TYPES.has(storage.type)) {
    return { ...base, ok: true, skipped: true };
  }
  try {
    const client = createClient(storage, env, storage.id);
    await withTimeout(client.listObjects(''), CHECK_TIMEOUT_MS);
    return { ...base, ok: true };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : '检测失败',
    };
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db);
  if (!isAdmin) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    storageId?: number;
  };

  let targets: Storage[];
  if (body.storageId) {
    const one = await getStorageById(db, Number(body.storageId));
    if (!one) {
      return Response.json({ error: 'Storage not found' }, { status: 404 });
    }
    targets = [one];
  } else {
    targets = await getAllStorages(db);
  }

  const results = await Promise.all(
    targets.map((storage) => checkStorage(storage, context.cloudflare.env)),
  );
  return Response.json({ results, checkedAt: Date.now() });
}
