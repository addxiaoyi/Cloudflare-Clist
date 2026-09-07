// 依据环境变量生成部署用 wrangler.jsonc（非敏感变量写入 config，敏感凭据走 wrangler secret）
import fs from "node:fs";

const env = process.env;

const cfg = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: env.WORKER_NAME || "clist",
  main: env.WORKER_MAIN || "./workers/app.ts",
  compatibility_date: env.COMPATIBILITY_DATE || "2025-04-04",
  keep_vars: true,
  observability: { enabled: (env.OBSERVABILITY_ENABLED || "true") === "true" },
  vars: {
    SITE_TITLE: env.SITE_TITLE || "CList",
    SITE_ANNOUNCEMENT: env.SITE_ANNOUNCEMENT || "",
    CHUNK_SIZE_MB: env.CHUNK_SIZE_MB || "50",
    WEBDAV_ENABLED: env.WEBDAV_ENABLED || "false",
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || "",
    GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI || "",
  },
  d1_databases: [
    {
      binding: env.D1_BINDING || "DB",
      database_name: env.D1_DATABASE_NAME || "clist",
      database_id: env.D1_DATABASE_ID,
      migrations_dir: env.D1_MIGRATIONS_DIR || "./migrations",
    },
  ],
};

// 配置了 R2 桶名则自动挂载，未配置则不带 r2_buckets 绑定
if (env.R2_BUCKET_NAME) {
  cfg.r2_buckets = [{ binding: "R2", bucket_name: env.R2_BUCKET_NAME }];
}

fs.writeFileSync("wrangler.jsonc", JSON.stringify(cfg, null, 2) + "\n");
