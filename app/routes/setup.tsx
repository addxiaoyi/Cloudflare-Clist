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
  token: string;
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
  github: { repoOwner: "", repoName: "", token: "" },
};

// ---------------------------------------------------------------------------
// 字段格式校验
// ---------------------------------------------------------------------------

const HEX32 = /^[a-f0-9]{32}$/i;
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GitHub Secrets / Variables 一键写入
// ---------------------------------------------------------------------------

const GH_API = "https://api.github.com";

interface WriteTarget {
  name: string;
  kind: "secret" | "variable";
  value: string;
}

interface WriteEntry {
  name: string;
  kind: "secret" | "variable";
  status: "pending" | "ok" | "error";
  detail?: string;
}

function b64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// libsodium crypto_box_seal：GitHub Secrets API 要求的加密格式。
// tweetnacl 含 Node 端 require('crypto')，只能在浏览器侧动态加载，避免污染 SSR 产物。
type NaclModule = typeof import("tweetnacl");
type BlakeModule = typeof import("blakejs");
let naclMod: NaclModule | null = null;
let blake2bFn: BlakeModule["blake2b"] | null = null;

async function loadCrypto(): Promise<void> {
  if (!naclMod) {
    const [n, b] = await Promise.all([import("tweetnacl"), import("blakejs")]);
    naclMod = n;
    blake2bFn = b.blake2b;
  }
}

async function boxSeal(value: string, recipientKeyB64: string): Promise<string> {
  await loadCrypto();
  const recipient = bytesFromB64(recipientKeyB64);
  const ephemeral = naclMod!.box.keyPair();
  const nonce = blake2bFn!(new Uint8Array([...ephemeral.publicKey, ...recipient]), undefined, 24);
  const cipher = naclMod!.box(new TextEncoder().encode(value), nonce, recipient, ephemeral.secretKey);
  const out = new Uint8Array(32 + cipher.length);
  out.set(ephemeral.publicKey, 0);
  out.set(cipher, 32);
  return b64FromBytes(out);
}

async function ghJson(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

async function writeGitHubSecret(owner: string, repo: string, name: string, value: string, token: string): Promise<void> {
  const keyRes = await ghJson(token, `/repos/${owner}/${repo}/actions/secrets/public-key`);
  if (!keyRes.ok) throw new Error(`获取公钥失败 (${keyRes.status})`);
  const key = (await keyRes.json()) as { key_id: string; key: string };
  const res = await ghJson(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: await boxSeal(value, key.key), key_id: key.key_id }),
  });
  if (!res.ok) throw new Error(`写入失败 (${res.status})`);
}

async function writeGitHubVariable(owner: string, repo: string, name: string, value: string, token: string): Promise<void> {
  const payload = JSON.stringify({ name, value });
  let res = await ghJson(token, `/repos/${owner}/${repo}/actions/variables/${name}`, {
    method: "PUT",
    body: payload,
  });
  if (res.status === 404) {
    res = await ghJson(token, `/repos/${owner}/${repo}/actions/variables`, {
      method: "POST",
      body: payload,
    });
  }
  if (!res.ok) throw new Error(`写入失败 (${res.status})`);
}

function collectWriteTargets(state: SetupState): WriteTarget[] {
  const targets: WriteTarget[] = [];
  const add = (name: string, kind: "secret" | "variable", value: string) => {
    if (value) targets.push({ name, kind, value });
  };
  add("CLOUDFLARE_API_TOKEN", "secret", state.cloudflare.apiToken);
  add("CLOUDFLARE_ACCOUNT_ID", "secret", state.cloudflare.accountId);
  add("WORKER_NAME", "variable", state.cloudflare.workerName);
  add("COMPATIBILITY_DATE", "variable", state.cloudflare.compatibilityDate);
  add("OBSERVABILITY_ENABLED", "variable", state.cloudflare.observability ? "true" : "false");
  add("SITE_TITLE", "variable", state.site.siteTitle);
  add("SITE_ANNOUNCEMENT", "variable", state.site.announcement);
  add("CHUNK_SIZE_MB", "variable", String(state.site.chunkSizeMb));
  if (state.site.adminUsername && state.site.adminPassword) {
    add("ADMIN_USERNAME", "secret", state.site.adminUsername);
    add("ADMIN_PASSWORD", "secret", state.site.adminPassword);
  }
  if (state.d1.enabled) {
    add("D1_DATABASE_NAME", "variable", state.d1.databaseName);
    add("D1_BINDING", "variable", state.d1.binding);
  }
  add("WEBDAV_ENABLED", "variable", state.webdav.enabled ? "true" : "false");
  if (state.webdav.enabled) {
    add("WEBDAV_USERNAME", "secret", state.webdav.username);
    add("WEBDAV_PASSWORD", "secret", state.webdav.password);
  }
  if (state.r2.enabled) add("R2_BUCKET_NAME", "variable", state.r2.bucketName);
  if (state.gdrive.enabled) {
    add("GOOGLE_CLIENT_ID", "variable", state.gdrive.clientId);
    add("GOOGLE_REDIRECT_URI", "variable", state.gdrive.redirectUri);
    add("GOOGLE_CLIENT_SECRET", "secret", state.gdrive.clientSecret);
  }
  return targets;
}

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

  lines.push("# 1. 认证", 'export CLOUDFLARE_API_TOKEN="<你的API_Token>"', cloudflare.accountId ? `export CLOUDFLARE_ACCOUNT_ID="${cloudflare.accountId}"` : "# Account ID 可留空：wrangler 会用 API Token 自动识别", "");

  if (d1.enabled) {
    lines.push(`# 2. D1 数据库：GitHub Actions 部署时会自动查找或创建（无需手动执行）`, `# 本地部署首次需执行: npx wrangler d1 create ${d1.databaseName}`, "");
  }

  if (r2.enabled) {
    lines.push(`# 3. R2 桶：GitHub Actions 部署时会自动创建（无需手动执行）`, `# 本地部署首次需执行: npx wrangler r2 bucket create ${r2.bucketName}`, "");
  }

  lines.push(`# 4. 部署 Worker`, `npx wrangler deploy --config wrangler.jsonc`, "");

  if (site.adminUsername && site.adminPassword) {
    lines.push(`# 5. 写入管理员凭据`, `printf '%s' "${site.adminUsername}" | npx wrangler secret put ADMIN_USERNAME --config wrangler.jsonc`, `printf '%s' "${site.adminPassword}" | npx wrangler secret put ADMIN_PASSWORD --config wrangler.jsonc`, "");
  } else {
    lines.push(`# 5. 管理员凭据未填：CI 首次部署自动生成并打印在 Actions 日志，后续部署沿用；本地部署请先补上`, "");
  }

  if (webdav.enabled) {
    lines.push(`# 6. WebDAV 凭据`, `printf '%s' "${webdav.username}" | npx wrangler secret put WEBDAV_USERNAME --config wrangler.jsonc`, `printf '%s' "${webdav.password}" | npx wrangler secret put WEBDAV_PASSWORD --config wrangler.jsonc`, "");
  }

  if (gdrive.enabled) {
    lines.push(`# 7. Google Drive OAuth（Client ID / 回调地址已在 wrangler.jsonc 的 vars 中）`, `printf '%s' "${gdrive.clientSecret}" | npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.jsonc`, "");
  }

  if (repo) {
    lines.push(`# 8. GitHub Actions 一键部署（仅需 CLOUDFLARE_API_TOKEN；也可在上一步用「一键写入」代替以下命令）`, `gh secret set CLOUDFLARE_API_TOKEN --repo ${repo} --body "<你的API_Token>"`, `# Account ID / D1 未配置时自动推导或创建；管理员凭据首次自动生成、后续沿用`);
    if (site.adminUsername && site.adminPassword) {
      lines.push(`gh secret set ADMIN_USERNAME --repo ${repo} --body "${site.adminUsername}"`, `gh secret set ADMIN_PASSWORD --repo ${repo} --body "${site.adminPassword}"`);
    }
    if (r2.enabled) lines.push(`gh variable set R2_BUCKET_NAME --repo ${repo} --body "${r2.bucketName}"`);
    if (webdav.enabled) {
      lines.push(`gh secret set WEBDAV_USERNAME --repo ${repo} --body "${webdav.username}"`, `gh secret set WEBDAV_PASSWORD --repo ${repo} --body "${webdav.password}"`);
    }
    if (gdrive.enabled) {
      lines.push(`gh variable set GOOGLE_CLIENT_ID --repo ${repo} --body "${gdrive.clientId}"`, `gh variable set GOOGLE_REDIRECT_URI --repo ${repo} --body "${gdrive.redirectUri}"`, `gh secret set GOOGLE_CLIENT_SECRET --repo ${repo} --body "${gdrive.clientSecret}"`);
    }
    if (d1.enabled) {
      lines.push(`# D1 无需手动配置：CI 会自动查找或创建数据库，并自动推导 Account ID（API Token 需有 D1 权限）`);
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
  const [writeLog, setWriteLog] = useState<WriteEntry[]>([]);
  const [writing, setWriting] = useState(false);

  const pushWrite = (target: WriteTarget, status: WriteEntry["status"], detail?: string) => {
    setWriteLog((prev) => {
      const next = prev.filter((e) => e.name !== target.name);
      return [...next, { name: target.name, kind: target.kind, status, detail }];
    });
  };

  const runWriteAll = async () => {
    const { repoOwner, repoName, token } = state.github;
    if (!repoOwner || !repoName || !token) return;
    const targets = collectWriteTargets(state);
    if (targets.length === 0) return;
    setWriting(true);
    setWriteLog(targets.map((t) => ({ name: t.name, kind: t.kind, status: "pending" as const })));
    // 先验证 token 与仓库可达，给出清晰报错
    const probe = await ghJson(token, `/repos/${repoOwner}/${repoName}`).catch(() => null);
    if (!probe) {
      setWriteLog((prev) => [
        ...prev,
        { name: "仓库检查", kind: "secret", status: "error", detail: "网络错误，无法连接 GitHub API" },
      ]);
      setWriting(false);
      return;
    }
    if (!probe.ok) {
      setWriteLog((prev) => [
        ...prev,
        {
          name: "仓库检查",
          kind: "secret",
          status: "error",
          detail: probe.status === 404 ? "仓库不存在或 Token 无访问权限" : `GitHub API 返回 ${probe.status}`,
        },
      ]);
      setWriting(false);
      return;
    }
    let failed = 0;
    for (const t of targets) {
      try {
        if (t.kind === "secret") {
          await writeGitHubSecret(repoOwner, repoName, t.name, t.value, token);
        } else {
          await writeGitHubVariable(repoOwner, repoName, t.name, t.value, token);
        }
        pushWrite(t, "ok");
      } catch (err) {
        failed += 1;
        pushWrite(t, "error", err instanceof Error ? err.message : String(err));
      }
    }
    setWriting(false);
    if (failed === 0) {
      pushWrite(
        { name: "全部完成", kind: "variable", value: "" },
        "ok",
        "Secrets / Variables 已写入，push 代码后即自动部署"
      );
    }
  };

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
    if (!!state.site.adminUsername.trim() !== !!state.site.adminPassword.trim()) errors.push("管理员用户名与密码需同时填写，或都留空由部署时自动生成");
    else if (state.site.adminPassword.length > 0 && state.site.adminPassword.length < 6) errors.push("管理员密码至少 6 位");
    if (state.cloudflare.accountId.trim() && !HEX32.test(state.cloudflare.accountId.trim())) errors.push("Account ID 应为 32 位十六进制");
    if (!WORKER_NAME_RE.test(state.cloudflare.workerName)) errors.push("Worker 名称只能含字母、数字、连字符");
    if (!DATE_RE.test(state.cloudflare.compatibilityDate)) errors.push("兼容日期格式应为 YYYY-MM-DD");
    if (state.r2.enabled && !state.r2.bucketName.trim()) errors.push("R2 桶名必填");
    if (state.gdrive.enabled) {
      if (!state.gdrive.clientId.trim() || !state.gdrive.clientSecret.trim()) errors.push("Google Client ID / Secret 必填");
      if (!state.gdrive.redirectUri.trim()) errors.push("Google 回调地址必填");
      else if (!isHttpsUrl(state.gdrive.redirectUri.trim())) errors.push("Google 回调地址必须是合法的 HTTPS URL");
    }
    if (state.webdav.enabled) {
      if (!state.webdav.username.trim()) errors.push("WebDAV 用户名必填");
      if (!state.webdav.password.trim()) errors.push("WebDAV 密码必填");
    }
    return errors;
  }, [state]);

  const canNext = step < STEPS.length - 1;
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  // 仅校验当前步骤的必填项，避免下一步按钮被后续步骤拦截
  const stepErrors = useMemo(() => {
    const errors: string[] = [];
    if (current.key === "site") {
      if (!!state.site.adminUsername.trim() !== !!state.site.adminPassword.trim()) errors.push("管理员用户名与密码需同时填写，或都留空自动生成");
      else if (state.site.adminPassword.length > 0 && state.site.adminPassword.length < 6) errors.push("管理员密码至少 6 位");
    } else if (current.key === "cloudflare") {
      if (state.cloudflare.accountId.trim() && !HEX32.test(state.cloudflare.accountId.trim())) errors.push("Account ID 应为 32 位十六进制");
      if (!WORKER_NAME_RE.test(state.cloudflare.workerName)) errors.push("Worker 名称只能含字母、数字、连字符");
      if (!DATE_RE.test(state.cloudflare.compatibilityDate)) errors.push("兼容日期格式应为 YYYY-MM-DD");
    } else if (current.key === "r2") {
      if (state.r2.enabled && !state.r2.bucketName.trim()) errors.push("R2 桶名必填");
    } else if (current.key === "gdrive") {
      if (state.gdrive.enabled) {
        if (!state.gdrive.clientId.trim() || !state.gdrive.clientSecret.trim()) errors.push("Google Client ID / Secret 必填");
        if (!state.gdrive.redirectUri.trim()) errors.push("Google 回调地址必填");
        else if (!isHttpsUrl(state.gdrive.redirectUri.trim())) errors.push("Google 回调地址必须是合法的 HTTPS URL");
      }
    } else if (current.key === "webdav") {
      if (state.webdav.enabled) {
        if (!state.webdav.username.trim()) errors.push("WebDAV 用户名必填");
        if (!state.webdav.password.trim()) errors.push("WebDAV 密码必填");
      }
    }
    return errors;
  }, [state, current.key]);

  const copy = async (kind: "json" | "cmd") => {
    const text = kind === "json" ? wranglerJson : commands;
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallback();
      }
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // 剪贴板 API 被拒绝时退回 textarea 方案
      try {
        fallback();
        setCopied(kind);
        setTimeout(() => setCopied(null), 2000);
      } catch {
        /* 均不可用时静默 */
      }
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
    setTouched(true);
    if (stepErrors.length > 0) return;
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
              <SectionTitle icon={<Megaphone className="h-4 w-4" />} title="站点与管理员账号" desc="管理员可留空：CI 部署时会自动生成并打印凭据" />
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
              <Field label="Account ID" hint="可留空：GitHub Actions 会从 API Token 自动推导">
                <input className={inputCls} value={state.cloudflare.accountId} onChange={(e) => patch("cloudflare", { accountId: e.target.value })} placeholder="可选，粘贴 Account ID" />
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
              <SectionTitle icon={<Github className="h-4 w-4" />} title="GitHub Actions 部署" desc="一键写入 Secrets / 变量，push 后自动构建部署" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="仓库 Owner">
                  <input className={inputCls} value={state.github.repoOwner} onChange={(e) => patch("github", { repoOwner: e.target.value })} placeholder="你的 GitHub 用户名" />
                </Field>
                <Field label="仓库名">
                  <input className={inputCls} value={state.github.repoName} onChange={(e) => patch("github", { repoName: e.target.value })} placeholder="repo-name" />
                </Field>
              </div>
              <Field label="GitHub Token（临时，仅本次写入使用）" hint="GitHub → Settings → Developer settings → Fine-grained PAT，需仓库 Actions 读写权限；不会保存到草稿之外，仅存于当前页面会话">
                <input className={inputCls} type="password" value={state.github.token} onChange={(e) => patch("github", { token: e.target.value })} placeholder="github_pat_..." />
              </Field>

              <button
                onClick={runWriteAll}
                disabled={writing || !state.github.token || !state.github.repoOwner || !state.github.repoName}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:enabled:hover:bg-zinc-300"
              >
                {writing ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> 正在写入…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" /> 一键写入 Secrets / 变量
                  </>
                )}
              </button>

              {writeLog.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-800">
                  {writeLog.map((e) => (
                    <div key={`${e.name}-${e.status}`} className="flex items-start gap-2 py-0.5">
                      <span
                        className={
                          e.status === "ok"
                            ? "text-emerald-500"
                            : e.status === "error"
                              ? "text-red-500"
                              : "text-zinc-400"
                        }
                      >
                        {e.status === "ok" ? <Check className="h-3.5 w-3.5" /> : e.status === "error" ? <AlertCircle className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                      </span>
                      <span className="font-medium text-zinc-600 dark:text-zinc-300">{e.name}</span>
                      <span className="text-zinc-400 dark:text-zinc-500">
                        {e.kind === "secret" ? "Secret" : "Variable"}
                        {e.detail ? ` · ${e.detail}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                一键写入会把全部 Secrets / 变量直接写入 GitHub 仓库。之后 <code className="text-zinc-600 dark:text-zinc-300">git push</code> 到 main/master 即自动部署。
                未使用一键写入时，也可用下方「部署命令」中的 <code className="text-zinc-600 dark:text-zinc-300">gh</code> 命令逐条执行（需先 <code className="text-zinc-600 dark:text-zinc-300">gh auth login</code>）。
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
              disabled={stepErrors.length > 0}
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
