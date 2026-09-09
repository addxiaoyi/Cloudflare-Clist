export interface MySqlConfig {
  connectionString: string;
  database?: string;
  tablePrefix?: string;
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

export class MySqlClient {
  private config: MySqlConfig;

  constructor(config: MySqlConfig, env?: { HYPERDRIVE?: { connectionString: string } }) {
    this.config = {
      ...config,
      connectionString: env?.HYPERDRIVE?.connectionString || config.connectionString,
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
    const countSql = `SELECT COUNT(*) as count FROM \`${db}\`.\`${table}\``;

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
    const conn = await createConnection({ uri: this.config.connectionString });
    try {
      const [rows] = await conn.query(sql, params);
      return rows as any[];
    } finally {
      await conn.end();
    }
  }
}