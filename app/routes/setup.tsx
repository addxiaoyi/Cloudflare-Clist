import { useState, useEffect, useMemo, useCallback } from "react";
import type { Route } from "./+types/setup";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  Download,
  Cloud,
  ShieldCheck,
  FolderPlus,
  Globe,
  Lock,
  Github,
  Link as LinkIcon,
  Megaphone,
  Upload,
  AlertCircle,
  RefreshCw,
} from "~/components/icons";

// ---------------------------------------------------------------------------
// 图形化初始化向导：分步收集配置，实时预览 wrangler.jsonc，并生成可执行的
// 部署命令（wrangler / gh）。草稿自动保存到 localStorage，刷新不丢失。
// ---------------------------------------------------------------------------

const DRAFT_KEY = "clist-setup-draft";

interface SiteConfig {
  siteTitle: string;
  announcement: string;
  chunkSizeMb: number;
  adminUsername: string;
  adminPassword: string;
}

interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  workerName: string;
  compatibilityDate: string;
  observability: boolean;
}

interface D1Config {
  enabled: boolean;
  databaseName: string;
  binding: string;
}

interface R2Config {
  enabled: boolean;
  bucketName: string;
  binding: string;
}

interface GDriveConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface WebdavConfig {
  enabled: boolean;
  username: string;
  password: string;
}

interface GithubConfig {
  repoOwner: string;
  repoName: string;
}

interface SetupState {
  site: SiteConfig;
  cloudflare: CloudflareConfig;
  d1: D1Config;
  r2: R2Config;
  gdrive: GDriveConfig;
  webdav: WebdavConfig;
  github: GithubConfig;
}

const emptyState: SetupState = {
  site: { siteTitle: "CList", announcement: "", chunkSizeMb: 50, adminUsername: "", adminPassword: "" },
  cloudflare: { apiToken: "", accountId: "", workerName: "clist", compatibilityDate: "2025-04-04", observability: true },
  d1: { enabled: true, databaseName: "clist", binding: "DB" },
  r2: { enabled: false, bucketName: "clist", binding: "R2" },
  gdrive: { enabled: false, clientId: "", clientSecret: "", redirectUri: "" },
  webdav: { enabled: false, username: "webdav", password: "" },
  github: { repoOwner: "", repoName: "" },
};

function loadDraft(): SetupState {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyState;
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    return {
      ...emptyState,
      ...parsed,
      site: { ...emptyState.site, ...parsed.site },
      cloudflare: { ...emptyState.cloudflare, ...parsed.cloudflare },
      d1: { ...emptyState.d1, ...parsed.d1 },
      r2: { ...emptyState.r2, ...parsed.r2 },
      gdrive: { ...emptyState.gdrive, ...parsed.gdrive },
      webdav: { ...emptyState.webdav, ...parsed.webdav },
      github: { ...emptyState.github, ...parsed.github },
    };
  } catch {
    return emptyState;
  }
}

// ---------------------------------------------------------------------------
// 输出产物生成
// ---------------------------------------------------------------------------

function buildWranglerJson(state: SetupState): object {
  const { site, cloudflare, d1, r2, gdrive, webdav } = state;
  const cfg: Record<string, unknown> = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: cloudflare.workerName,
    main: "./workers/app.ts",
    compatibility_date: cloudflare.compatibilityDate,
    keep_vars: true,
    observability: { enabled: cloudflare.observability },
    vars: {
      SITE_TITLE: site.siteTitle,
      SITE_ANNOUNCEMENT: site.announcement,
      CHUNK_SIZE_MB: String(site.chunkSizeMb),
      WEBDAV_ENABLED: webdav.enabled ? "true" : "false",
      GOOGLE_CLIENT_ID: gdrive.clientId,
      GOOGLE_CLIENT_SECRET: gdrive.clientSecret,
      GOOGLE_REDIRECT_URI: gdrive.redirectUri,
    },
  };
  if (d1.enabled) {
    cfg.d1_databases = [
      {
        binding: d1.binding,
        database_name: d1.databaseName,
        database_id: "REPLACE_WITH_D1_DATABASE_ID",
        migrations_dir: "./migrations",
      },
    ];
  }
  if (r2.enabled) {
    cfg.r2_buckets = [{ binding: r2.binding, bucket_name: r2.bucketName }];
  }
  return cfg;
}

function buildCommands(state: SetupState): string {
  const { site, cloudflare, d1, r2, gdrive, webdav, github } = state;
  const lines: string[] = [];
  const hasGh = github.repoOwner && github.repoName;
  const repo = hasGh ? `${github.repoOwner}/${github.repoName}` : "";

  lines.push("# 1. 认证", 'export CLOUDFLARE_API_TOKEN="<你的API_Token>"', `export CLOUDFLARE_ACCOUNT_ID="${cloudflare.accountId}"`, "");

  if (d1.enabled) {
    lines.push(`# 2. 创建 D1 数据库（仅首次）`, `npx wrangler d1 create ${d1.databaseName}`, `# 把返回的 database_id 填入 wrangler.jsonc 的 d1_databases[].database_id`, "");
  }

  if (r2.enabled) {
    lines.push(`# 3. 创建 R2 桶（仅首次）`, `npx wrangler r2 bucket create ${r2.bucketName}`, "");
  }

  lines.push(`# 4. 部署 Worker`, `npx wrangler deploy --config wrangler.jsonc`, "");

  lines.push(`# 5. 写入管理员凭据`, `printf '%s' "${site.adminUsername}" | npx wrangler secret put ADMIN_USERNAME --config wrangler.jsonc`, `printf '%s' "${site.adminPassword}" | npx wrangler secret put ADMIN_PASSWORD --config wrangler.jsonc`, "");

  if (webdav.enabled) {
    lines.push(`# 6. WebDAV 凭据`, `printf '%s' "${webdav.username}" | npx wrangler secret put WEBDAV_USERNAME --config wrangler.jsonc`, `printf '%s' "${webdav.password}" | npx wrangler secret put WEBDAV_PASSWORD --config wrangler.jsonc`, "");
  }

  if (gdrive.enabled) {
    lines.push(`# 7. Google Drive OAuth`, `npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.jsonc`, `npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.jsonc`, `npx wrangler secret put GOOGLE_REDIRECT_URI --config wrangler.jsonc`, "");
  }

  if (repo) {
    lines.push(`# 8. GitHub Actions 部署（可选，代替本地 wrangler 命令）`, `gh secret set CLOUDFLARE_API_TOKEN --repo ${repo} --body "<你的API_Token>"`, `gh secret set CLOUDFLARE_ACCOUNT_ID --repo ${repo} --body "${cloudflare.accountId}"`, `gh secret set ADMIN_USERNAME --repo ${repo} --body "${site.adminUsername}"`, `gh secret set ADMIN_PASSWORD --repo ${repo} --body "${site.adminPassword}"`);
    if (r2.enabled) lines.push(`gh variable set R2_BUCKET_NAME --repo ${repo} --body "${r2.bucketName}"`);
    if (gdrive.enabled) {
      lines.push(`gh variable set GOOGLE_CLIENT_ID --repo ${repo} --body "${gdrive.clientId}"`, `gh variable set GOOGLE_REDIRECT_URI --repo ${repo} --body "${gdrive.redirectUri}"`, `gh secret set GOOGLE_CLIENT_SECRET --repo ${repo} --body "${gdrive.clientSecret}"`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 表单控件
// ---------------------------------------------------------------------------

const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-zinc-500 dark:focus:ring-zinc-700";

const labelCls = "mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300";

const cardCls =
  "rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-left transition hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-zinc-600"
    >
      <span>
        <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">{label}</span>
        {desc ? <span className="mt-0.5 block text-xs text-zinc-400 dark:text-zinc-500">{desc}</span> : null}
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-4.5 translate-x-0" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

function SectionTitle({ icon, title, desc }: { icon: React.ReactNode; title: string; desc?: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        {icon}
      </span>
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {desc ? <p className="mt-0.5 text-sm text-zinc-400 dark:text-zinc-500">{desc}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 向导页面
// ---------------------------------------------------------------------------

const STEPS = [
  { key: "site", title: "站点与账号", icon: Megaphone },
  { key: "cloudflare", title: "Cloudflare", icon: Cloud },
  { key: "d1", title: "D1 数据库", icon: ShieldCheck },
  { key: "r2", title: "R2 存储", icon: FolderPlus },
  { key: "gdrive", title: "Google Drive", icon: Globe },
  { key: "webdav", title: "WebDAV", icon: Lock },
  { key: "github", title: "GitHub 部署", icon: Github },
  { key: "output", title: "生成配置", icon: Download },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return { prefillRepo: url.searchParams.get("repo") || "" };
}

export default function Setup({ loaderData }: Route.ComponentProps) {
  const [state, setState] = useState<SetupState>(loadDraft);
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState<"json" | "cmd" | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      github:
        loaderData.prefillRepo && !prev.github.repoOwner && !prev.github.repoName
          ? { ...prev.github, repoOwner: loaderData.prefillRepo.split("/")[0] || "", repoName: loaderData.prefillRepo.split("/")[1] || "" }
          : prev.github,
    }));
  }, [loaderData.prefillRepo]);

  // 草稿自动保存
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
      } catch {
        /* 存储不可用时忽略 */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [state]);

  const patch = useCallback(
    <K extends keyof SetupState>(section: K, values: Partial<SetupState[K]>) => {
      setState((prev) => ({ ...prev, [section]: { ...prev[section], ...values } }));
    },
    []
  );

  const wranglerJson = useMemo(() => JSON.stringify(buildWranglerJson(state), null, 2), [state]);
  const commands = useMemo(() => buildCommands(state), [state]);

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!state.site.adminUsername.trim()) errors.push("管理员用户名必填");
    if (state.site.adminPassword.length < 6) errors.push("管理员密码至少 6 位");
    if (!state.cloudflare.accountId.trim()) errors.push("Cloudflare Account ID 必填");
    if (state.r2.enabled && !state.r2.bucketName.trim()) errors.push("R2 桶名必填");
    if (state.gdrive.enabled && (!state.gdrive.clientId.trim() || !state.gdrive.clientSecret.trim())) errors.push("Google Client ID / Secret 必填");
    return errors;
  }, [state]);

  const canNext = step < STEPS.length - 1;
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  const copy = async (kind: "json" | "cmd") => {
    const text = kind === "json" ? wranglerJson : commands;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  const downloadJson = () => {
    const blob = new Blob([wranglerJson + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wrangler.jsonc";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const reset = () => {
    if (!confirm("确定清空所有配置草稿？")) return;
    localStorage.removeItem(DRAFT_KEY);
    setState(emptyState);
    setStep(0);
  };

  const next = () => {
    if (!canNext) return;
    if (current.key === "site" || current.key === "cloudflare") {
      setTouched(true);
      const relevant = current.key === "site" ? validation.filter((e) => e.includes("管理员")) : validation.filter((e) => e.includes("Cloudflare"));
      if (relevant.length > 0) return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  return (
    <div className="min-h-screen bg-zinc-50 py-8 dark:bg-zinc-950">
      <div className="mx-auto max-w-3xl px-4">
        {/* 顶部 */}
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">项目初始化向导</h1>
            <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">
              图形化完成 Cloudflare 部署、存储挂载与站点配置
            </p>
          </div>
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <RefreshCw className="h-3.5 w-3.5" /> 重置
          </button>
        </header>

        {/* 进度条 */}
        <div className="mb-6">
          <div className="flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s.key}
                onClick={() => i <= step && setStep(i)}
                disabled={i > step}
                title={s.title}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i < step
                    ? "bg-emerald-500"
                    : i === step
                      ? "bg-zinc-800 dark:bg-zinc-200"
                      : "bg-zinc-200 dark:bg-zinc-700"
                } ${i <= step ? "cursor-pointer" : "cursor-default"}`}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              第 {step + 1} / {STEPS.length} 步 · {current.title}
            </span>
            {validation.length > 0 && step < STEPS.length - 1 ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">{validation.length} 项待完善</span>
            ) : null}
          </div>
        </div>

        {/* 步骤导航 */}
        <nav className="mb-5 flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const done = i < step;
            return (
              <button
                key={s.key}
                onClick={() => i <= step && setStep(i)}
                disabled={i > step}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                  i === step
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : done
                      ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                }`}
              >
                {done ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                {s.title}
              </button>
            );
          })}
        </nav>

        {/* 步骤内容 */}
        <div className={cardCls}>
          {current.key === "site" && (
            <div className="space-y-4">
              <SectionTitle icon={<Megaphone className="h-4 w-4" />} title="站点与管理员账号" desc="基础信息与管理凭据，密码至少 6 位" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="站点标题">
                  <input className={inputCls} value={state.site.siteTitle} onChange={(e) => patch("site", { siteTitle: e.target.value })} placeholder="CList" />
                </Field>
                <Field label="上传分块大小 (MB)">
                  <input className={inputCls} type="number" min={1} max={200} value={state.site.chunkSizeMb} onChange={(e) => patch("site", { chunkSizeMb: Number(e.target.value) || 50 })} />
                </Field>
              </div>
              <Field label="站点公告（可选）">
                <input className={inputCls} value={state.site.announcement} onChange={(e) => patch("site", { announcement: e.target.value })} placeholder="欢迎使用 CList 存储服务" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="管理员用户名">
                  <input className={inputCls} value={state.site.adminUsername} onChange={(e) => patch("site", { adminUsername: e.target.value })} placeholder="admin" />
                </Field>
                <Field label="管理员密码">
                  <input className={inputCls} type={showSecrets ? "text" : "password"} value={state.site.adminPassword} onChange={(e) => patch("site", { adminPassword: e.target.value })} placeholder="至少 6 位" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                <input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} className="rounded border-zinc-300 dark:border-zinc-600" />
                显示密码明文
              </label>
            </div>
          )}

          {current.key === "cloudflare" && (
            <div className="space-y-4">
              <SectionTitle icon={<Cloud className="h-4 w-4" />} title="Cloudflare 连接" desc="用于本地 wrangler 部署或 GitHub Actions 自动部署" />
              <Field label="API Token（Secret）" hint="Cloudflare → My Profile → API Tokens → Edit Cloudflare Workers 模板">
                <input className={inputCls} type="password" value={state.cloudflare.apiToken} onChange={(e) => patch("cloudflare", { apiToken: e.target.value })} placeholder="粘贴 API Token" />
              </Field>
              <Field label="Account ID" hint="Cloudflare Dashboard 右侧栏">
                <input className={inputCls} value={state.cloudflare.accountId} onChange={(e) => patch("cloudflare", { accountId: e.target.value })} placeholder="粘贴 Account ID" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Worker 名称">
                  <input className={inputCls} value={state.cloudflare.workerName} onChange={(e) => patch("cloudflare", { workerName: e.target.value })} />
                </Field>
                <Field label="兼容日期">
                  <input className={inputCls} value={state.cloudflare.compatibilityDate} onChange={(e) => patch("cloudflare", { compatibilityDate: e.target.value })} />
                </Field>
              </div>
              <Toggle
                checked={state.cloudflare.observability}
                onChange={(v) => patch("cloudflare", { observability: v })}
                label="启用可观测性"
                desc="写入日志与指标，便于排查问题"
              />
            </div>
          )}

          {current.key === "d1" && (
            <div className="space-y-4">
              <SectionTitle icon={<ShieldCheck className="h-4 w-4" />} title="D1 数据库" desc="存储会话、分享链接与审计日志，必选" />
              <Toggle
                checked={state.d1.enabled}
                onChange={(v) => patch("d1", { enabled: v })}
                label="启用 D1 数据库"
                desc="建议保持启用，核心数据依赖 D1"
              />
              {state.d1.enabled && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="数据库名称">
                    <input className={inputCls} value={state.d1.databaseName} onChange={(e) => patch("d1", { databaseName: e.target.value })} />
                  </Field>
                  <Field label="Binding 名称">
                    <input className={inputCls} value={state.d1.binding} onChange={(e) => patch("d1", { binding: e.target.value })} />
                  </Field>
                </div>
              )}
              <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                部署前执行 <code className="text-zinc-600 dark:text-zinc-300">npx wrangler d1 create {state.d1.databaseName}</code> 并把返回的 database_id 填入生成的配置。
              </p>
            </div>
          )}

          {current.key === "r2" && (
            <div className="space-y-4">
              <SectionTitle icon={<FolderPlus className="h-4 w-4" />} title="R2 对象存储" desc="部署后自动挂载为「R2 存储」，可直接上传文件" />
              <Toggle
                checked={state.r2.enabled}
                onChange={(v) => patch("r2", { enabled: v })}
                label="启用 R2 桶"
                desc="需要账号已开通 R2 订阅"
              />
              {state.r2.enabled && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="桶名">
                    <input className={inputCls} value={state.r2.bucketName} onChange={(e) => patch("r2", { bucketName: e.target.value })} />
                  </Field>
                  <Field label="Binding 名称">
                    <input className={inputCls} value={state.r2.binding} onChange={(e) => patch("r2", { binding: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          )}

          {current.key === "gdrive" && (
            <div className="space-y-4">
              <SectionTitle icon={<Globe className="h-4 w-4" />} title="Google Drive 挂载" desc="原生 OAuth，授权后以云盘形式挂载" />
              <Toggle
                checked={state.gdrive.enabled}
                onChange={(v) => patch("gdrive", { enabled: v })}
                label="启用 Google Drive"
                desc="需先在 Google Cloud Console 创建 OAuth 2.0 客户端"
              />
              {state.gdrive.enabled && (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Client ID">
                      <input className={inputCls} value={state.gdrive.clientId} onChange={(e) => patch("gdrive", { clientId: e.target.value })} placeholder="xxx.apps.googleusercontent.com" />
                    </Field>
                    <Field label="Client Secret">
                      <input className={inputCls} type="password" value={state.gdrive.clientSecret} onChange={(e) => patch("gdrive", { clientSecret: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="回调地址" hint="必须与 Google 控制台 Authorized redirect URIs 完全一致">
                    <input className={inputCls} value={state.gdrive.redirectUri} onChange={(e) => patch("gdrive", { redirectUri: e.target.value })} placeholder="https://<worker域名>/api/gdrive-oauth" />
                  </Field>
                  <button
                    onClick={() => {
                      const host = state.cloudflare.workerName ? `${state.cloudflare.workerName}.workers.dev` : "";
                      if (host) patch("gdrive", { redirectUri: `https://${host}/api/gdrive-oauth` });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <LinkIcon className="h-3.5 w-3.5" /> 用默认 workers.dev 域名
                  </button>
                </div>
              )}
            </div>
          )}

          {current.key === "webdav" && (
            <div className="space-y-4">
              <SectionTitle icon={<Lock className="h-4 w-4" />} title="WebDAV 服务" desc="以 WebDAV 协议访问文件，兼容各平台客户端" />
              <Toggle
                checked={state.webdav.enabled}
                onChange={(v) => patch("webdav", { enabled: v })}
                label="启用 WebDAV"
                desc="需要独立的 WebDAV 凭据"
              />
              {state.webdav.enabled && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="用户名">
                    <input className={inputCls} value={state.webdav.username} onChange={(e) => patch("webdav", { username: e.target.value })} />
                  </Field>
                  <Field label="密码">
                    <input className={inputCls} type="password" value={state.webdav.password} onChange={(e) => patch("webdav", { password: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          )}

          {current.key === "github" && (
            <div className="space-y-4">
              <SectionTitle icon={<Github className="h-4 w-4" />} title="GitHub Actions 部署" desc="配置后每次 push 自动构建部署，跳过本地 wrangler 命令" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="仓库 Owner">
                  <input className={inputCls} value={state.github.repoOwner} onChange={(e) => patch("github", { repoOwner: e.target.value })} placeholder="你的 GitHub 用户名" />
                </Field>
                <Field label="仓库名">
                  <input className={inputCls} value={state.github.repoName} onChange={(e) => patch("github", { repoName: e.target.value })} placeholder="repo-name" />
                </Field>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                生成的命令会把全部 Secrets / Vars 写入 GitHub 仓库（使用 <code className="text-zinc-600 dark:text-zinc-300">gh</code> 命令，需先 <code className="text-zinc-600 dark:text-zinc-300">gh auth login</code>）。随后 push 到 main/master 即自动部署。
              </div>
            </div>
          )}

          {current.key === "output" && (
            <div className="space-y-5">
              <SectionTitle icon={<Download className="h-4 w-4" />} title="生成配置" desc="预览 wrangler.jsonc 与完整部署命令，复制或下载" />

              {validation.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">还有 {validation.length} 项未完善</p>
                    <ul className="mt-1 list-inside list-disc text-xs">
                      {validation.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">wrangler.jsonc</h3>
                  <div className="flex gap-2">
                    <button onClick={() => copy("json")} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                      {copied === "json" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied === "json" ? "已复制" : "复制"}
                    </button>
                    <button onClick={downloadJson} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                      <Download className="h-3.5 w-3.5" /> 下载
                    </button>
                  </div>
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100 dark:border-zinc-800">
                  {wranglerJson}
                </pre>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">部署命令</h3>
                  <button onClick={() => copy("cmd")} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                    {copied === "cmd" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied === "cmd" ? "已复制" : "复制"}
                  </button>
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100 dark:border-zinc-800">
                  {commands}
                </pre>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400">
                <Upload className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  已自动保存草稿（本地浏览器）。按照「部署命令」逐步执行即可完成初始化；部署后管理员在「存储管理」页挂载各存储，R2 桶会自动出现。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部导航 */}
        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-600 transition enabled:hover:border-zinc-300 enabled:hover:text-zinc-900 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:enabled:hover:text-zinc-100"
          >
            <ChevronLeft className="h-4 w-4" /> 上一步
          </button>
          {isLast ? (
            <div className="flex items-center gap-2">
              {validation.length === 0 && (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="h-4 w-4" /> 配置完整
                </span>
              )}
              <button
                onClick={() => setStep(0)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                <RefreshCw className="h-4 w-4" /> 重新开始
              </button>
            </div>
          ) : (
            <button
              onClick={next}
              disabled={validation.length > 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:enabled:hover:bg-zinc-300"
            >
              下一步 <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>

        {touched && validation.length > 0 && step < STEPS.length - 1 ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5" /> 请先完善上方标出的必填项
          </p>
        ) : null}
      </div>
    </div>
  );
}
