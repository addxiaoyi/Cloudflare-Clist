export interface MySqlConfig {
  connectionString: string;
  database?: string;
  tablePrefix?: string;
}

// Hyperdrive 绑定形状（env.HD / env.HYPERDRIVE）
export interface HyperdriveLike {
  connectionString: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
}

function escapeIdentifier(id: string): string {
  return `\`${id.replace(/`/g, "``")}\``;
}

export class MySqlClient {
  private config: MySqlConfig;
  private hyperdrive?: HyperdriveLike;

  constructor(
    config: MySqlConfig,
    env?: { HD?: HyperdriveLike; HYPERDRIVE?: HyperdriveLike }
  ) {
    this.config = { ...config };
    // 优先使用 Hyperdrive 连接（生产环境必须通过 Hyperdrive 访问 MySQL，
    // Workers 无法直接建立到公网 3306 的 TCP 连接）
    this.hyperdrive = env?.HD || env?.HYPERDRIVE;
  }

  // 构造 mysql2 连接参数：Hyperdrive 优先；无 Hyperdrive 时回退到存储自身
  // 的连接串（仅本地开发/直连场景）。disableEval 是 Cloudflare 官方要求的
  // Workers 兼容项，必须开启。
  private buildConnectionOptions(): Record<string, unknown> {
    if (this.hyperdrive) {
      return {
        host: this.hyperdrive.host,
        port: this.hyperdrive.port,
        user: this.hyperdrive.user,
        password: this.hyperdrive.password,
        database: this.hyperdrive.database,
        disableEval: true,
      };
    }
    return {
      uri: this.config.connectionString,
      disableEval: true,
    };
  }

  async listDatabases(): Promise<string[]> {
    const sql = "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name";
    const results = await this.rawQuery(sql);
    return results.map((r: any) => r.schema_name);
  }

  async listTables(db: string): Promise<string[]> {
    const sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`;
    const results = await this.rawQuery(sql, db);
    return results.map((r: any) => r.table_name);
  }

  async getTableInfo(db: string, table: string): Promise<TableInfo | null> {
    const columnsSql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`;
    const countSql = `SELECT COUNT(*) as count FROM ${escapeIdentifier(db)}.${escapeIdentifier(table)}`;

    try {
      const columns = await this.rawQuery(columnsSql, db, table);
      const countResult = await this.rawQuery(countSql);

      return {
        name: table,
        columns: columns.map((c: any) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
          defaultValue: c.column_default,
        })),
        rowCount: countResult[0]?.count || 0,
      };
    } catch {
      return null;
    }
  }

  async query(sql: string, params?: any[]): Promise<QueryResult> {
    const results = await this.rawQuery(sql, ...(params || []));
    if (results.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const columns = Object.keys(results[0]);
    return {
      columns,
      rows: results,
      rowCount: results.length,
    };
  }

  async exec(sql: string, params?: any[]): Promise<{ affectedRows: number }> {
    const results = await this.rawQuery(sql, ...(params || []));
    return { affectedRows: results.length };
  }

  private async rawQuery(sql: string, ...params: any[]): Promise<any[]> {
    const { createConnection } = await import("mysql2/promise");
    const conn = await createConnection(this.buildConnectionOptions());
    try {
      const [rows] = await conn.query(sql, params);
      return rows as any[];
    } finally {
      await conn.end();
    }
  }
}