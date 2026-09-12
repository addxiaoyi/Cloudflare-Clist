import { useNavigate, useLoaderData, Form } from "react-router";
import { getStorageById, initDatabase } from "~/lib/storage";
import { createMysqlClient } from "~/lib/client-factory";
import { requireAuth } from "~/lib/auth";
import { Database, TableIcon as Table, RefreshCw, Play as Execute, ChevronLeft } from "~/components/icons";

interface LoaderData {
  storage?: { id: number; name: string; config: any };
  databases?: string[];
  selectedDb?: string;
  tables?: string[];
  selectedTable?: string;
  tableInfo?: TableInfo;
  queryResult?: QueryResult;
  error?: string;
  query?: string;
}

interface TableInfo {
  name: string;
  columns: { name: string; type: string; nullable: boolean; defaultValue: string | null }[];
  rowCount: number;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
}

export async function loader({ request, params, context }: any) {
  const env = (context as any).cloudflare.env;
  const search = new URL(request.url).searchParams;
  const storageId = parseInt(params.storageId || "0", 10);

  const authResult = await requireAuth(request, env.DB);
  if (!authResult.session) {
    return { error: "Unauthorized" };
  }

  await initDatabase(env.DB);
  const storage = await getStorageById(env.DB, storageId);
  if (!storage || storage.type !== "mysql") {
    return { error: "MySQL storage not found" };
  }

  const client = createMysqlClient(storage, { HYPERDRIVE: env.HD });
  const action = search.get("action");
  const db = search.get("db");
  const table = search.get("table");
  const sql = search.get("sql");

  let result: LoaderData = { storage, query: sql || "" };

  try {
    if (action === "listDatabases") {
      result.databases = await client.listDatabases();
    } else if (action === "listTables" && db) {
      result.selectedDb = db;
      result.tables = await client.listTables(db);
    } else if (action === "tableInfo" && db && table) {
      result.selectedDb = db;
      result.selectedTable = table;
      result.tableInfo = await client.getTableInfo(db, table) || undefined;
    } else if (action === "query" && sql) {
      result.queryResult = await client.query(sql);
    }
  } catch (e: any) {
    result.error = e.message;
  }

  return result;
}

export async function action({ request, params }: any) {
  const formData = await request.formData();
  const action = formData.get("action") as string;
  const storageId = parseInt(params.storageId || "0", 10);

  const body = {
    storageId,
    action,
    db: formData.get("db") as string || undefined,
    table: formData.get("table") as string || undefined,
    sql: formData.get("sql") as string || undefined,
  };

  return body;
}

export default function MySqlPage() {
  const data = useLoaderData() as LoaderData;
  const navigate = useNavigate();

  // loader 未返回存储（不存在/非 MySQL/未登录）时给出友好提示，避免 data.storage 解构崩溃
  if (!data.storage) {
    return (
      <div className="p-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <button
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => navigate("/")}
            aria-label="返回首页"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <Database className="h-6 w-6 text-blue-500" />
          <h1 className="text-lg font-semibold">MySQL 数据库</h1>
        </div>
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3">
          <p className="text-red-700 dark:text-red-200">
            {data.error === "Unauthorized"
              ? "请先登录管理员账号后再访问 MySQL 管理页面"
              : data.error || "MySQL 存储不存在或类型不正确，请检查存储配置"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <button
          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={() => navigate("/")}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <Database className="h-6 w-6 text-blue-500" />
        <h1 className="text-lg font-semibold">{data.storage.name}</h1>
        <RefreshCw className="h-4 w-4 ml-auto cursor-pointer" onClick={() => window.location.reload()} />
      </div>

      {data.error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-3 mb-4">
          <p className="text-red-700 dark:text-red-200">错误: {data.error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-1">
          <h2 className="font-medium mb-2">数据库</h2>
          <div className="space-y-1">
            {data.databases?.map((db) => (
              <form key={db} method="get">
                <button
                  type="submit"
                  name="action"
                  value="listTables"
                  className="w-full text-left px-3 py-1.5 text-sm rounded bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                >
                  {db}
                </button>
              </form>
            ))}
          </div>
        </div>

        <div className="md:col-span-2">
          {data.tables && data.selectedDb && (
            <>
              <h2 className="font-medium mb-2">表 ({data.tables.length})</h2>
              <div className="space-y-1 mb-4">
                {data.tables.map((table) => (
                  <form key={table} method="get">
                    <input type="hidden" name="action" value="tableInfo" />
                    <input type="hidden" name="db" value={data.selectedDb} />
                    <input type="hidden" name="table" value={table} />
                    <button
                      type="submit"
                      className="w-full text-left px-3 py-1.5 text-sm rounded bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
                    >
                      <Table className="h-4 w-4" />
                      {table}
                      <span className="text-xs text-zinc-500 ml-auto">
                        {data.tableInfo?.name === table && `${data.tableInfo.rowCount} 行`}
                      </span>
                    </button>
                  </form>
                ))}
              </div>

              {data.tableInfo && (
                <div>
                  <h3 className="font-medium mb-2">列</h3>
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-100 dark:bg-zinc-800">
                        <tr>
                          <th className="px-3 py-2 text-left">名称</th>
                          <th className="px-3 py-2 text-left">类型</th>
                          <th className="px-3 py-2 text-left">可空</th>
                          <th className="px-3 py-2 text-left">默认值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.tableInfo.columns.map((col) => (
                          <tr key={col.name} className="border-t border-zinc-200 dark:border-zinc-700">
                            <td className="px-3 py-1.5 font-mono">{col.name}</td>
                            <td className="px-3 py-1.5 font-mono text-xs">{col.type}</td>
                            <td className="px-3 py-1.5 text-xs">{col.nullable ? "YES" : "NO"}</td>
                            <td className="px-3 py-1.5 font-mono text-xs">{String(col.defaultValue || "")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-6">
        <h3 className="font-medium mb-2">SQL 查询</h3>
        <Form method="get" className="space-y-2">
          <input
            type="text"
            name="sql"
            defaultValue={data.query}
            placeholder="SELECT * FROM table LIMIT 10"
            className="w-full px-3 py-2 border rounded text-sm"
          />
          <button type="submit" className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
            <Execute className="h-4 w-4" />
            执行查询
          </button>
        </Form>

        {data.queryResult && (() => {
          const qr = data.queryResult;
          return (
            <div className="mt-4">
              <div className="text-xs text-zinc-500 mb-2">
                返回 {qr.rowCount} 行
              </div>
              <div className="border rounded overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 dark:bg-zinc-800">
                    <tr>
                      {qr.columns.map((col) => (
                        <th key={col} className="px-3 py-2 font-mono text-xs">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {qr.rows.map((row, i) => (
                      <tr key={i} className="border-t border-zinc-200 dark:border-zinc-700">
                        {qr.columns.map((col) => (
                          <td key={col} className="px-3 py-1.5 font-mono text-xs">
                            {String(row[col] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}