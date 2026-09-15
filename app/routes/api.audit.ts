import type { Route } from './+types/api.audit';
import { initDatabase } from '~/lib/storage';
import { requireAuth } from '~/lib/auth';
import { getAuditLogs } from '~/lib/audit';

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db, 'admin');
  if (!isAdmin) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || '200', 10),
    500,
  );
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const action = url.searchParams.get('action') || undefined;
  const storageIdParam = url.searchParams.get('storageId');
  const storageId = storageIdParam ? parseInt(storageIdParam, 10) : undefined;
  const userType =
    (url.searchParams.get('userType') as 'guest' | 'admin' | 'share' | null) ||
    undefined;

  const logs = await getAuditLogs(db, {
    limit: Number.isNaN(limit) ? 200 : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
    action,
    storageId: Number.isNaN(storageId as number) ? undefined : storageId,
    userType,
  });

  return Response.json({ logs });
}
