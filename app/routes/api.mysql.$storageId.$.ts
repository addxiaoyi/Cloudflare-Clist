import { getStorageById, initDatabase } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";
import { createMysqlClient } from "~/lib/client-factory";

async function validateAndSetup(request: Request, env: any, storageId: number) {
  const authResult = await requireAuth(request, env.DB, "admin");
  if (!authResult.isAdmin) {
    throw new Error("Unauthorized");
  }
  await initDatabase(env.DB);
  const storage = await getStorageById(env.DB, storageId);
  if (!storage) {
    throw new Error("Storage not found");
  }
  if (storage.type !== "mysql") {
    throw new Error("Storage type must be mysql");
  }
  const client = createMysqlClient(storage, env);
  return { client, storage };
}

function error(err: unknown): Response {
  return Response.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
}

function notFound(msg: string): Response {
  return Response.json({ error: msg }, { status: 404 });
}

function badRequest(msg: string): Response {
  return Response.json({ error: msg }, { status: 400 });
}

type RouteLoaderArgs = {
  request: Request;
  params: { storageId: string; "*": string };
  context: { cloudflare: { env: any } };
};

type RouteActionArgs = RouteLoaderArgs;

export async function loader({ request, params, context }: RouteLoaderArgs) {
  const env = (context as any).cloudflare.env;
  const action = params["*"] || "";
  const storageId = parseInt(params.storageId || "0", 10);

  if (storageId <= 0) {
    return notFound("Invalid storage ID");
  }

  try {
    const { client } = await validateAndSetup(request, env, storageId);

    if (action === "databases") {
      const dbs = await client.listDatabases();
      return Response.json({ databases: dbs });
    }

    if (action.startsWith("tables/")) {
      const db = action.slice(7);
      const tables = await client.listTables(db);
      return Response.json({ tables });
    }

    if (action.startsWith("info/")) {
      const [db, table] = action.slice(5).split("/");
      if (!db || !table) {
        return badRequest("Invalid database/table path");
      }
      const info = await client.getTableInfo(db, table);
      if (!info) {
        return notFound(`Table ${table} not found in ${db}`);
      }
      return Response.json(info);
    }

    return notFound(`Unknown action: ${action}`);
  } catch (err) {
    return error(err);
  }
}

export async function action({ request, params, context }: RouteLoaderArgs) {
  const env = (context as any).cloudflare.env;
  const storageId = parseInt(params.storageId || "0", 10);

  if (storageId <= 0) {
    return badRequest("Invalid storage ID");
  }

  try {
    const { client } = await validateAndSetup(request, env, storageId);
    const body: Record<string, any> = await (request.json() as Promise<Record<string, any>>).catch(() => ({}));

    if (!body.sql) {
      return badRequest("Missing 'sql' field");
    }

    const sql = body.sql as string;
    const params2: any[] = body.params || [];

    if (/^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\s/i.test(sql)) {
      const result = await client.query(sql, params2);
      return Response.json({
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
      });
    }

    const execResult = await client.exec(sql, params2);
    return Response.json({ affectedRows: execResult.affectedRows });
  } catch (err) {
    return error(err);
  }
}