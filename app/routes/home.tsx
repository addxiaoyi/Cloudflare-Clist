import type { Route } from './+types/home';
import { requireAuth } from '~/lib/auth';
import { getAllStorages, getPublicStorages, initDatabase } from '~/lib/storage';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FilePreview } from '~/components/FilePreview';
import { Logo } from '~/components/Logo';
import { useToast, useConfirm } from '~/components/feedback';
import { getFileType, isPreviewable } from '~/lib/file-utils';
import {
  GIT_TYPES,
  getGitMaxFileBytes,
  getGitMaxFileLabel,
} from '~/lib/git/registry';
import { apiFileUrl } from '~/lib/api-path';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  X,
  Plus,
  Search,
  Sun,
  Moon,
  SlidersHorizontal,
  LogIn,
  LogOut,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
  ArrowRightLeft,
  RefreshCw,
  PanelLeft,
  FolderPlus,
  Upload,
  Download,
  Copy,
  Share2,
  Pencil,
  Trash2,
  Play,
  BarChart3,
  FileText,
  Folder,
  AlertCircle,
  fileTypeIcon,
  Globe,
  LayoutGrid,
  List,
  Star,
  Calculator,
  Eye,
  EyeClosed,
  QrCode,
  Smartphone,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Check,
  Pause,
  Resume,
  StopCircle,
  GripVertical,
} from '~/components/icons';

// dnd-kit imports
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  defaultDropAnimationSideEffects,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  type SortableAttributes,
  type SortableSyntheticListeners,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export function meta({ data }: Route.MetaArgs) {
  const title = data?.siteTitle || 'Starx';
  return [
    { title: `${title} - 存储聚合` },
    { name: 'description', content: 'S3 兼容存储聚合服务' },
  ];
}

// 下发给浏览器的存储 config 需脱敏：OAuth 密钥/令牌/会话 Cookie 不给前端
const SENSITIVE_CONFIG_KEYS = new Set([
  'client_secret',
  'refresh_token',
  'access_token',
  'token', // GitHub PAT
  'cloudflare_access_token',
  'cloudflare_refresh_token',
  'cookie',
  'bduss',
  'stoken',
  'access_key_id',
  'secret_access_key',
  'access_key',
  'secret_key',
]);

function sanitizeConfigForClient(
  config: Record<string, any> | undefined,
): Record<string, any> {
  if (!config) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = SENSITIVE_CONFIG_KEYS.has(k) ? '***' : v;
  }
  return out;
}

// 剔除服务端脱敏占位符 "***"，防止未改动的密钥被回写覆盖
function stripMaskedConfig(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v !== '***') out[k] = v;
  }
  return out;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const siteTitle = context.cloudflare.env.SITE_TITLE || 'Starx';
  const siteAnnouncement = context.cloudflare.env.SITE_ANNOUNCEMENT || '';
  const chunkSizeMB = parseInt(
    context.cloudflare.env.CHUNK_SIZE_MB || '50',
    10,
  );
  const webdavEnabled =
    (context.cloudflare.env.WEBDAV_ENABLED as string) === 'true';

  if (!db) {
    console.error('D1 Database not bound');
    return {
      isAdmin: false,
      storages: [],
      siteTitle,
      siteAnnouncement,
      chunkSizeMB,
      webdavEnabled: false,
    };
  }

  try {
    await initDatabase(db);
    const { isAdmin } = await requireAuth(request, db);
    const storages = isAdmin
      ? await getAllStorages(db)
      : await getPublicStorages(db);

    return {
      isAdmin,
      siteTitle,
      siteAnnouncement,
      chunkSizeMB,
      webdavEnabled,
      storages: storages.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        endpoint: s.endpoint,
        region: s.region,
        accessKeyId: s.accessKeyId,
        bucket: s.bucket,
        basePath: s.basePath,
        config: isAdmin ? sanitizeConfigForClient(s.config) : undefined,
        isPublic: s.isPublic,
        guestList: s.guestList,
        guestDownload: s.guestDownload,
        guestUpload: s.guestUpload,
      })),
    };
  } catch (err) {
    console.error('Failed to initialize database:', err);
    return {
      isAdmin: false,
      storages: [],
      siteTitle,
      siteAnnouncement,
      chunkSizeMB,
      webdavEnabled,
    };
  }
}

interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

interface StorageInfo {
  id: number;
  name: string;
  type?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  bucket?: string;
  basePath?: string;
  config?: Record<string, any>;
  isPublic: boolean;
  guestList: boolean;
  guestDownload: boolean;
  guestUpload: boolean;
  description?: string;
}

interface UploadProgress {
  name: string;
  progress: number;
  currentPart?: number;
  totalParts?: number;
  speed?: number;
  loaded?: number;
  total?: number;
  status: 'uploading' | 'paused' | 'error' | 'success';
  errorMessage?: string;
  startTime?: number;
  pausedAt?: number;
  retryCount?: number;
  failedParts?: number[];
  abortController?: AbortController;
  partProgress?: Record<number, number>;
  partSizes?: Record<number, number>;
}

type ConfigField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select' | 'boolean';
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
  show?: (values: Record<string, any>) => boolean;
  help?: string;
  link?: { url: string; text: string };
  pattern?: string;
  patternHint?: string;
};

const driveConfigMap: Record<
  string,
  {
    name: string;
    supportsMultipart: boolean;
    fields: ConfigField[];
    oauth?: boolean;
  }
> = {
  onedrive: {
    name: 'OneDrive',
    supportsMultipart: true,
    fields: [
      {
        key: 'region',
        label: '区域',
        type: 'select',
        required: true,
        options: [
          { value: 'global', label: '全球版' },
          { value: 'cn', label: '中国版（世纪互联）' },
          { value: 'us', label: '美国政府版' },
          { value: 'de', label: '德国版' },
        ],
        defaultValue: 'global',
      },
      {
        key: 'refresh_token',
        label: '刷新令牌',
        type: 'textarea',
        required: true,
        placeholder: 'Microsoft OAuth 刷新令牌',
        help: '最省事：点表单底部「通过 Microsoft 授权」按钮自动换取。手动获取需先在 Azure 注册应用并走授权码流程，详见 docs/CREDENTIAL_GUIDE.md。',
        link: {
          url: 'https://learn.microsoft.com/en-us/onedrive/developer/rest-api/getting-started/graph-oauth',
          text: 'Graph OAuth 教程 →',
        },
      },
      {
        key: 'use_online_api',
        label: '使用在线API',
        type: 'boolean',
        defaultValue: true,
        help: '开启后由在线服务托管密钥并自动续期令牌',
      },
      {
        key: 'api_address',
        label: '在线API地址',
        type: 'text',
        defaultValue: 'https://api.oplist.org/onedrive/renewapi',
        placeholder: '自建刷新接口地址',
        show: (values) => values.use_online_api === true,
        help: '默认使用公共刷新网关；自建服务时替换为自己的 renewapi 地址',
      },
      {
        key: 'client_id',
        label: '客户端ID',
        type: 'text',
        placeholder: '本地客户端ID',
        show: (values) => values.use_online_api !== true,
        help: 'Azure 应用注册里的 Application (client) ID',
        link: {
          url: 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
          text: 'Azure 应用注册 →',
        },
      },
      {
        key: 'client_secret',
        label: '客户端密钥',
        type: 'password',
        placeholder: '本地客户端密钥',
        show: (values) => values.use_online_api !== true,
        help: '同一应用内 Certificates & secrets → New client secret，值只显示一次请立即复制',
      },
      {
        key: 'redirect_uri',
        label: '重定向URI',
        type: 'text',
        placeholder: 'https://api.oplist.org/onedrive/callback',
        defaultValue: 'https://api.oplist.org/onedrive/callback',
        show: (values) => values.use_online_api !== true,
        help: '必须与 Azure 应用 Authentication 页登记的 Redirect URI 完全一致，否则报 AADSTS50011',
      },
      {
        key: 'is_sharepoint',
        label: 'SharePoint 模式',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'site_id',
        label: 'SharePoint 站点ID',
        type: 'text',
        placeholder: 'SharePoint 站点ID',
        show: (values) => values.is_sharepoint === true,
      },
      {
        key: 'root_folder_path',
        label: '根文件夹路径',
        type: 'text',
        defaultValue: '/',
      },
      {
        key: 'chunk_size',
        label: '分块大小 (MB)',
        type: 'text',
        defaultValue: '5',
      },
      {
        key: 'custom_host',
        label: '自定义下载主机',
        type: 'text',
        placeholder: '可选：自定义下载域名',
      },
    ],
  },
  gdrive: {
    name: 'Google Drive',
    supportsMultipart: true,
    fields: [
      {
        key: 'refresh_token',
        label: '刷新令牌',
        type: 'textarea',
        required: true,
        placeholder: 'Google OAuth 刷新令牌',
        help: '最省事：点表单底部「通过 Google 授权」按钮。手动获取需在 Google Cloud 创建 Web 应用型 OAuth 客户端并换取 refresh_token，详见 docs/CREDENTIAL_GUIDE.md。',
        link: {
          url: 'https://console.cloud.google.com/apis/credentials',
          text: 'Google Cloud 凭据页 →',
        },
      },
      {
        key: 'use_online_api',
        label: '使用在线API',
        type: 'boolean',
        defaultValue: true,
        help: '开启后由在线服务托管密钥并自动续期令牌',
      },
      {
        key: 'api_address',
        label: '在线API地址',
        type: 'text',
        defaultValue: 'https://api.oplist.org/googleui/renewapi',
        placeholder: '自建刷新接口地址',
        show: (values) => values.use_online_api === true,
        help: '默认使用公共刷新网关；自建服务时替换为自己的 renewapi 地址',
      },
      {
        key: 'client_id',
        label: '客户端ID',
        type: 'text',
        placeholder: '本地客户端ID',
        show: (values) => values.use_online_api !== true,
        help: 'OAuth 客户端 ID；先在 OAuth 同意屏幕启用 Drive 范围',
        link: {
          url: 'https://console.cloud.google.com/apis/credentials',
          text: '创建 OAuth 客户端 →',
        },
      },
      {
        key: 'client_secret',
        label: '客户端密钥',
        type: 'password',
        placeholder: '本地客户端密钥',
        show: (values) => values.use_online_api !== true,
        help: '同一 OAuth 客户端的 Client secret',
      },
      {
        key: 'root_folder_id',
        label: '根目录ID',
        type: 'text',
        defaultValue: 'root',
        placeholder: '默认 root',
      },
      {
        key: 'order_by',
        label: '排序字段',
        type: 'text',
        defaultValue: 'folder,name,modifiedTime',
        placeholder: 'folder,name,modifiedTime',
      },
      {
        key: 'order_direction',
        label: '排序方向',
        type: 'select',
        options: [
          { value: 'asc', label: '升序' },
          { value: 'desc', label: '降序' },
        ],
        defaultValue: 'asc',
      },
      {
        key: 'chunk_size',
        label: '分块大小 (MB)',
        type: 'text',
        defaultValue: '5',
      },
    ],
  },
  alicloud: {
    name: '阿里云盘',
    supportsMultipart: true,
    fields: [
      {
        key: 'drive_type',
        label: '驱动类型',
        type: 'select',
        required: true,
        options: [
          { value: 'resource', label: '资源库' },
          { value: 'backup', label: '备份盘' },
          { value: 'default', label: '默认' },
        ],
        defaultValue: 'resource',
      },
      {
        key: 'refresh_token',
        label: '刷新令牌',
        type: 'textarea',
        required: true,
        help: '开启「使用在线API」时无需填写；本地模式需从阿里云盘开放平台或已登录会话中取得 refresh_token，详见 docs/CREDENTIAL_GUIDE.md。',
        link: { url: 'https://open.alipan.com/', text: '阿里云盘开放平台 →' },
      },
      {
        key: 'root_folder_id',
        label: '根目录ID',
        type: 'text',
        defaultValue: 'root',
      },
      {
        key: 'order_by',
        label: '排序方式',
        type: 'select',
        options: [
          { value: 'name', label: '文件名' },
          { value: 'size', label: '文件大小' },
          { value: 'updated_at', label: '修改时间' },
          { value: 'created_at', label: '创建时间' },
        ],
        defaultValue: 'name',
      },
      {
        key: 'order_direction',
        label: '排序方向',
        type: 'select',
        options: [
          { value: 'ASC', label: '升序' },
          { value: 'DESC', label: '降序' },
        ],
        defaultValue: 'ASC',
      },
      {
        key: 'use_online_api',
        label: '使用在线API',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'api_address',
        label: '在线API地址',
        type: 'text',
        defaultValue: 'https://api.oplist.org/alicloud/renewapi',
        placeholder: '自建刷新接口地址',
        show: (values) => values.use_online_api === true,
      },
      {
        key: 'client_id',
        label: '客户端ID',
        type: 'text',
        placeholder: '本地客户端ID',
        show: (values) => values.use_online_api !== true,
        help: '阿里云盘开放平台应用的 AppID',
        link: { url: 'https://open.alipan.com/', text: '申请应用 →' },
      },
      {
        key: 'client_secret',
        label: '客户端密钥',
        type: 'password',
        placeholder: '本地客户端密钥',
        show: (values) => values.use_online_api !== true,
        help: '同一应用的 AppSecret，注意不要泄露给前端',
      },
      {
        key: 'remove_way',
        label: '删除方式',
        type: 'select',
        options: [
          { value: 'trash', label: '移到回收站' },
          { value: 'delete', label: '直接删除' },
        ],
        defaultValue: 'trash',
      },
      {
        key: 'rapid_upload',
        label: '秒传',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'internal_upload',
        label: '内网上传',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'livp_download_format',
        label: 'LIVP 下载格式',
        type: 'select',
        options: [
          { value: 'jpeg', label: 'JPEG' },
          { value: 'mov', label: 'MOV' },
        ],
        defaultValue: 'jpeg',
      },
      {
        key: 'alipan_type',
        label: '云盘类型',
        type: 'select',
        options: [
          { value: 'default', label: '默认' },
          { value: 'alipanTV', label: '阿里云盘TV' },
        ],
        defaultValue: 'default',
      },
    ],
  },
  baiduyun: {
    name: '百度网盘',
    supportsMultipart: false,
    fields: [
      {
        key: 'refresh_token',
        label: '刷新令牌',
        type: 'textarea',
        required: true,
        help: '开启「使用在线API」时由后端自动续期。若本地使用，需在百度智能云创建应用并走授权码流程换取 refresh_token，详见 docs/CREDENTIAL_GUIDE.md。',
        link: {
          url: 'https://console.bce.baidu.com/iam/app',
          text: '百度智能云应用管理 →',
        },
      },
      {
        key: 'root_path',
        label: '根目录路径',
        type: 'text',
        defaultValue: '/',
      },
      {
        key: 'order_by',
        label: '排序方式',
        type: 'select',
        options: [
          { value: 'name', label: '文件名' },
          { value: 'time', label: '修改时间' },
          { value: 'size', label: '文件大小' },
        ],
        defaultValue: 'name',
      },
      {
        key: 'order_direction',
        label: '排序方向',
        type: 'select',
        options: [
          { value: 'asc', label: '升序' },
          { value: 'desc', label: '降序' },
        ],
        defaultValue: 'asc',
      },
      {
        key: 'use_online_api',
        label: '使用在线API',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'api_address',
        label: '在线API地址',
        type: 'text',
        defaultValue: 'https://api.oplist.org/baiduyun/renewapi',
        placeholder: '自建刷新接口地址',
        show: (values) => values.use_online_api === true,
      },
      {
        key: 'client_id',
        label: '客户端ID',
        type: 'text',
        placeholder: '本地客户端ID',
        show: (values) => values.use_online_api !== true,
        help: '百度智能云应用的 Client ID（API Key），需在应用详情里查看',
        link: {
          url: 'https://console.bce.baidu.com/iam/app',
          text: '创建应用 →',
        },
      },
      {
        key: 'client_secret',
        label: '客户端密钥',
        type: 'password',
        placeholder: '本地客户端密钥',
        show: (values) => values.use_online_api !== true,
        help: '同应用的 Secret Key，创建后请妥善保存',
      },
    ],
  },
  quark: {
    name: '夸克网盘',
    supportsMultipart: false,
    fields: [
      {
        key: 'cookie',
        label: 'Cookie',
        type: 'textarea',
        required: true,
        placeholder:
          '点下方「扫码登录获取 Cookie」自动填入；或登录 pan.quark.cn 后 F12 抓取',
        help: '推荐用下方「扫码登录」按钮，夸克 App 扫码后 Cookie 自动回填；手动抓取步骤见 docs/CREDENTIAL_GUIDE.md。',
        link: { url: 'https://pan.quark.cn/', text: '夸克网盘网页版 →' },
      },
      {
        key: 'root_path',
        label: '根目录路径',
        type: 'text',
        defaultValue: '/',
      },
      {
        key: 'use_online_api',
        label: '使用在线API',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'api_address',
        label: '在线API地址',
        type: 'text',
        defaultValue: 'https://api.oplist.org/quark/renewapi',
        placeholder: '自建刷新接口地址',
        show: (values) => values.use_online_api === true,
      },
    ],
  },
  tigris: {
    name: 'Tigris 对象存储',
    supportsMultipart: true,
    fields: [
      {
        key: 'region',
        label: '区域',
        type: 'select',
        required: true,
        options: [
          { value: 'us-east-1', label: '美国东部' },
          { value: 'eu-central-1', label: '欧洲中部' },
          { value: 'ap-southeast-1', label: '亚太东南' },
        ],
        defaultValue: 'us-east-1',
      },
      {
        key: 'endpoint',
        label: '端点',
        type: 'text',
        defaultValue: 'https://fly/storage',
        placeholder: 'https://fly/storage',
        help: 'Tigris 的 S3 兼容端点，按区域选择',
        link: {
          url: 'https://docs.tigrisdata.com/overview',
          text: 'Tigris 端点说明 →',
        },
      },
      {
        key: 'bucket',
        label: '存储桶名',
        type: 'text',
        required: true,
        placeholder: 'my-bucket',
      },
      {
        key: 'access_key_id',
        label: '访问密钥 ID',
        type: 'password',
        required: true,
        placeholder: 'Tigris Access Key ID',
        help: '控制台 Access Keys → Create New Access Key 生成',
        link: { url: 'https://console.storage.dev/', text: 'Tigris 控制台 →' },
      },
      {
        key: 'secret_access_key',
        label: '访问密钥',
        type: 'password',
        required: true,
        placeholder: 'Tigris Secret Access Key',
      },
      {
        key: 'session_token',
        label: '会话令牌',
        type: 'password',
        placeholder: '可选：临时凭证',
      },
      {
        key: 'use_ssl',
        label: '启用 SSL',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'path_style',
        label: '路径风格访问',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'signature_version',
        label: '签名版本',
        type: 'select',
        options: [
          { value: 'v4', label: 'SigV4 (推荐)' },
          { value: 'v2', label: 'SigV2 (旧版兼容)' },
        ],
        defaultValue: 'v4',
      },
      {
        key: 'root_folder_path',
        label: '根目录路径',
        type: 'text',
        defaultValue: '/',
      },
    ],
  },
  qiniu: {
    name: '七牛云 KODO',
    supportsMultipart: true,
    fields: [
      {
        key: 'region',
        label: '区域',
        type: 'select',
        required: true,
        options: [
          { value: 'z0', label: '华东' },
          { value: 'z1', label: '华北' },
          { value: 'z2', label: '华南' },
          { value: 'cn-east-2', label: '华东-2' },
          { value: 'na0', label: '北美-洛杉矶' },
          { value: 'as0', label: '亚太-新加坡' },
          { value: 'as2', label: '亚太-胡志明' },
        ],
        defaultValue: 'z0',
      },
      {
        key: 'bucket',
        label: '存储桶名',
        type: 'text',
        required: true,
        placeholder: 'my-kodo-bucket',
      },
      {
        key: 'access_key',
        label: 'Access Key',
        type: 'password',
        required: true,
        placeholder: '七牛 Access Key',
        help: '七牛云控制台 -> 个人中心 -> 密钥管理 -> AccessKey',
        link: { url: 'https://portal.qiniu.com/user/key', text: '密钥管理 →' },
      },
      {
        key: 'secret_key',
        label: 'Secret Key',
        type: 'password',
        required: true,
        placeholder: '七牛 Secret Key',
        help: '同上创建时显示一次的 SecretKey',
      },
      {
        key: 'session_token',
        label: '会话令牌',
        type: 'password',
        placeholder: '可选：STS 临时凭证 Security Token',
        help: '使用 STS Federated Token 时填写 SecurityToken，可提升安全性',
        link: {
          url: 'https://developer.qiniu.com/kodo/kb/3495/sts',
          text: '七牛 STS 文档 →',
        },
      },
      {
        key: 'domain',
        label: '域名',
        type: 'text',
        placeholder: 'https://cdn.example.com（可选）',
      },
      {
        key: 'root_folder_path',
        label: '根目录路径',
        type: 'text',
        defaultValue: '/',
      },
      {
        key: 'use_https',
        label: '使用 HTTPS',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },
  ftp: {
    name: 'FTP 文件网关',
    supportsMultipart: false,
    fields: [
      {
        key: 'endpoint',
        label: 'HTTP 网关地址',
        type: 'text',
        required: true,
        placeholder: 'https://ftp.example.com/dav',
        help: '自建 FTP/WebDAV 网关的 HTTP 入口地址，需以 https:// 开头并以路径结尾',
      },
      {
        key: 'username',
        label: '用户名',
        type: 'text',
        required: true,
        placeholder: 'FTP 用户名',
        help: '网关登录用户名',
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        placeholder: 'FTP 密码',
        help: '网关登录密码',
      },
      {
        key: 'base_path',
        label: '根目录路径',
        type: 'text',
        defaultValue: '/',
        help: '限定可访问的起始目录，越界路径会被拒绝',
      },
      {
        key: 'use_https',
        label: '使用 HTTPS',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  },
  mysql: {
    name: 'MySQL 数据库',
    supportsMultipart: false,
    fields: [
      {
        key: 'database',
        label: '数据库名',
        type: 'text',
        required: true,
        placeholder: 'my_database',
        help: '通过 Hyperdrive 绑定时填写目标数据库名',
      },
      {
        key: 'table_prefix',
        label: '表前缀',
        type: 'text',
        placeholder: '可选：wp_',
        help: '仅处理带该前缀的表，常用于 WordPress 等',
      },
      {
        key: 'connection_string',
        label: '直连连接串（可选）',
        type: 'textarea',
        required: false,
        placeholder:
          'mysql://user:pass@host:port/db（未绑定 Hyperdrive 时使用）',
        help: '未绑定 Hyperdrive 时才填写，建议仅在本地开发使用；生产推荐绑定 Cloudflare Hyperdrive',
        link: {
          url: 'https://developers.cloudflare.com/hyperdrive/',
          text: 'Hyperdrive 文档 →',
        },
      },
    ],
  },
  'r2-oauth': {
    name: 'Cloudflare R2 (OAuth)',
    supportsMultipart: false,
    fields: [
      {
        key: 'account_id',
        label: 'Cloudflare 账户 ID',
        type: 'text',
        required: true,
        placeholder: 'e.g.: 1234567890abcdef',
        help: '在 Cloudflare 控制台右侧「账户 ID」处复制',
        link: {
          url: 'https://dash.cloudflare.com/',
          text: 'Cloudflare 控制台 →',
        },
      },
      {
        key: 'bucket',
        label: 'R2 存储桶名',
        type: 'text',
        required: true,
        placeholder: 'my-r2-bucket',
        help: '授权方账户下可访问的 R2 Bucket 名称',
      },
    ],
    oauth: true,
  },
  dropbox: {
    name: 'Dropbox',
    supportsMultipart: false,
    fields: [
      {
        key: 'access_token',
        label: 'Access Token',
        type: 'password',
        required: true,
        help: '在 Dropbox App Console 创建 Scoped Access 应用，勾选权限后生成 Access Token。长期令牌需选择 Offline 授权并换取 refresh_token。',
        link: {
          url: 'https://www.dropbox.com/developers/apps',
          text: 'Dropbox 应用控制台 →',
        },
      },
      {
        key: 'root_path',
        label: '根目录路径',
        type: 'text',
        defaultValue: '',
        help: '限定在 /Appname 等目录内操作，留空表示账户根目录',
      },
    ],
  },
  github: {
    name: 'GitHub 仓库',
    supportsMultipart: false,
    fields: [
      {
        key: 'repo',
        label: '仓库',
        type: 'text',
        required: true,
        placeholder: 'owner/repo 或 https://github.com/owner/repo',
        help: '支持 owner/repo 或完整 GitHub URL，粘贴自浏览器地址栏即可',
      },
      {
        key: 'token',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'ghp_xxx 或 github_pat_xxx',
        help: 'Classic Token 请勾选 repo 范围；Fine-grained 需授予 Contents: Read/Write',
        link: {
          url: 'https://github.com/settings/tokens/new?description=Sandbox%20Storage&scopes=repo',
          text: '前往 GitHub 生成 Token →',
        },
      },
      {
        key: 'branch',
        label: '分支',
        type: 'text',
        defaultValue: 'main',
        placeholder: 'main',
        help: '仓库默认分支，一般为 main 或 master',
      },
      {
        key: 'root_path',
        label: '仓库内子目录',
        type: 'text',
        defaultValue: '',
        placeholder: '如 docs/assets，留空用仓库根',
        help: '给定时仅在该子目录内读写，越界路径会被拒绝',
      },
      {
        key: 'api_base',
        label: 'API 地址',
        type: 'text',
        defaultValue: 'https://api.github.com',
        placeholder: 'https://api.github.com',
        help: 'GitHub Enterprise 才需修改；公共 GitHub 保持默认即可',
        show: (v) => v.custom_api_base === true,
      },
      {
        key: 'custom_api_base',
        label: '使用自定义 API 地址',
        type: 'boolean',
        defaultValue: false,
        help: '勾选后显示 API 地址字段，GitHub Enterprise 自建站点才需要',
      },
    ],
  },
  gitlab: {
    name: 'GitLab 仓库',
    supportsMultipart: false,
    fields: [
      {
        key: 'repo',
        label: '仓库',
        type: 'text',
        required: true,
        placeholder:
          'namespace/project 或 https://gitlab.com/group/subgroup/project',
        help: '支持 namespace/project 或完整 GitLab URL；嵌套分组会自动拼接',
      },
      {
        key: 'token',
        label: 'Private Access Token',
        type: 'password',
        required: true,
        placeholder: 'glpat-xxx',
        help: '需授予 read_repository/write_repository 权限',
        link: {
          url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
          text: '前往 GitLab 生成 Token →',
        },
      },
      {
        key: 'branch',
        label: '分支',
        type: 'text',
        defaultValue: 'main',
        placeholder: 'main',
        help: '仓库默认分支，一般为 main 或 master',
      },
      {
        key: 'root_path',
        label: '仓库内子目录',
        type: 'text',
        defaultValue: '',
        placeholder: '如 docs/assets，留空用仓库根',
        help: '给定时仅在该子目录内读写，越界路径会被拒绝',
      },
      {
        key: 'api_base',
        label: 'API 地址',
        type: 'text',
        defaultValue: 'https://gitlab.com/api/v4',
        placeholder: 'https://gitlab.com/api/v4',
        help: '自建 GitLab 才需修改；公共 GitLab 保持默认即可',
        show: (v) => v.custom_api_base === true,
      },
      {
        key: 'custom_api_base',
        label: '使用自定义 API 地址',
        type: 'boolean',
        defaultValue: false,
        help: '勾选后显示 API 地址字段，自建 GitLab 实例才需要',
      },
    ],
  },
  gitea: {
    name: 'Gitea / Forgejo 仓库',
    supportsMultipart: false,
    fields: [
      {
        key: 'repo',
        label: '仓库',
        type: 'text',
        required: true,
        placeholder: 'owner/repo 或 https://gitea.example.com/owner/repo',
        help: '支持 owner/repo 或完整仓库 URL',
      },
      {
        key: 'token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'gitea_token 或带上 API 地址',
        help: '在 Gitea/Forgejo 个人设置中生成 API Token',
        link: {
          url: 'https://gitea.com/user/settings/applications',
          text: '前往生成 Token →',
        },
      },
      {
        key: 'branch',
        label: '分支',
        type: 'text',
        defaultValue: 'main',
        placeholder: 'main',
        help: '仓库默认分支，一般为 main 或 master',
      },
      {
        key: 'root_path',
        label: '仓库内子目录',
        type: 'text',
        defaultValue: '',
        placeholder: '如 docs/assets，留空用仓库根',
        help: '给定时仅在该子目录内读写，越界路径会被拒绝',
      },
      {
        key: 'api_base',
        label: 'API 地址',
        type: 'text',
        defaultValue: 'https://gitea.com/api/v1',
        placeholder: 'https://gitea.com/api/v1',
        help: '自建 Gitea/Forgejo 实例才需修改；公共 Gitea 保持默认即可',
        show: (v) => v.custom_api_base === true,
      },
      {
        key: 'custom_api_base',
        label: '使用自定义 API 地址',
        type: 'boolean',
        defaultValue: false,
        help: '勾选后显示 API 地址字段，自建实例才需要',
      },
    ],
  },
  gitee: {
    name: 'Gitee 仓库',
    supportsMultipart: false,
    fields: [
      {
        key: 'repo',
        label: '仓库',
        type: 'text',
        required: true,
        placeholder: 'owner/repo 或 https://gitee.com/owner/repo',
        help: '支持 owner/repo 或完整仓库 URL',
      },
      {
        key: 'token',
        label: '私人令牌',
        type: 'password',
        required: true,
        placeholder: 'gitee_xxx（Access Token）',
        help: '作为 access_token 查询参数传入，确保 token 拥有仓库读写权限',
        link: {
          url: 'https://gitee.com/profile/personal_access_tokens',
          text: '前往 Gitee 生成令牌 →',
        },
      },
      {
        key: 'branch',
        label: '分支',
        type: 'text',
        defaultValue: 'master',
        placeholder: 'master',
        help: 'Gitee 默认分支一般为 master',
      },
      {
        key: 'root_path',
        label: '仓库内子目录',
        type: 'text',
        defaultValue: '',
        placeholder: '如 docs/assets，留空用仓库根',
        help: '给定时仅在该子目录内读写，越界路径会被拒绝',
      },
      {
        key: 'api_base',
        label: 'API 地址',
        type: 'text',
        defaultValue: 'https://gitee.com/api/v5',
        placeholder: 'https://gitee.com/api/v5',
        help: '默认走官方 API；一般无需修改',
        show: (v) => v.custom_api_base === true,
      },
      {
        key: 'custom_api_base',
        label: '使用自定义 API 地址',
        type: 'boolean',
        defaultValue: false,
        help: '勾选后显示 API 地址字段',
      },
    ],
  },
};

function supportsMultipart(type?: string): boolean {
  if (!type) {
    return true;
  }
  if (type === 'webdev') {
    return false;
  }
  if (type === 's3') {
    return true;
  }
  const config = driveConfigMap[type];
  if (config) {
    return config.supportsMultipart;
  }
  return false;
}

interface AuditLog {
  id: number;
  action: string;
  storageId: number | null;
  path: string | null;
  userType: 'guest' | 'admin' | 'share';
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '-';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return (
    parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  );
}

function formatTimeLeft(
  bytesPerSecond: number,
  bytesRemaining: number,
): string {
  if (bytesPerSecond === 0 || bytesRemaining <= 0) return '计算中...';
  const seconds = Math.ceil(bytesRemaining / bytesPerSecond);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN');
}

function Modal({
  title,
  onClose,
  children,
  maxWidth = 'max-w-sm',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidth} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  required?: boolean;
  help?: string;
  link?: { url: string; text: string };
  pattern?: string;
  patternHint?: string;
}

function PasswordInput({
  value,
  onChange,
  label,
  required,
  help,
  link,
  pattern,
  patternHint,
}: PasswordInputProps) {
  const [showValue, setShowValue] = useState(false);

  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1.5">
        {label}
        {required ? ' *' : ''}
        {link && (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 underline underline-offset-2"
          >
            {link.text}
          </a>
        )}
      </label>
      <div className="relative">
        <input
          type={showValue ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full field"
          required={required}
          pattern={pattern}
          title={patternHint}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowValue(!showValue)}
            className="text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
            title={showValue ? '隐藏密钥' : '显示密钥'}
          >
            {showValue ? (
              <EyeClosed className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
          {value && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(value)}
              className="text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              title="复制密钥"
            >
              <Copy className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {help && <p className="text-xs text-zinc-500 mt-1.5">{help}</p>}
      {value && (
        <span className="text-xs text-zinc-500 mt-1 block">
          当前值：{value.slice(0, 4)}****{value.slice(-4)}
        </span>
      )}
    </div>
  );
}

function LoginModal({
  onLogin,
  onClose,
}: {
  onLogin: () => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', username, password, remember }),
      });

      if (res.ok) {
        onLogin();
      } else {
        const data = (await res.json()) as { error?: string; hint?: string };
        setError(data.hint || data.error || '登录失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-sm rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">
            管理员登录
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full field"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full field"
              required
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-blue-600"
            />
            记住我（30 天内免登录）
          </label>
          {error && (
            <div className="text-red-500 dark:text-red-400 text-xs font-medium">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm transition rounded"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 transition rounded"
            >
              {loading ? '...' : '登录'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------- 夸克扫码登录常量 ---------- */
const QUARK_QR_TTL_SEC = 300;
const QUARK_QR_POLL_MS = 3000;

function StorageModal({
  storage,
  onSave,
  onCancel,
}: {
  storage?: StorageInfo;
  onSave: () => void;
  onCancel: () => void;
}) {
  const initConfig = (type: string, existing?: Record<string, any>) => {
    const fields = driveConfigMap[type]?.fields || [];
    const base = { ...(existing || {}) };
    if (base.api_address === undefined && base.api_url_address !== undefined) {
      base.api_address = base.api_url_address;
    }
    const hasLocalClient = Boolean(
      String(base.client_id || '').trim() &&
      String(base.client_secret || '').trim(),
    );
    for (const field of fields) {
      if (base[field.key] === undefined && field.defaultValue !== undefined) {
        // 已有本地客户端凭据时默认走本地（官方）刷新，避免把原生授权存储切回在线聚合 API
        if (field.key === 'use_online_api' && hasLocalClient) {
          base[field.key] = false;
          continue;
        }
        base[field.key] = field.defaultValue;
      }
    }
    if (
      fields.some((field) => field.key === 'use_online_api') &&
      !hasLocalClient &&
      base.use_online_api === undefined
    ) {
      base.use_online_api = true;
    }
    return base;
  };

  const [formData, setFormData] = useState({
    name: storage?.name || '',
    type: storage?.type || 's3',
    endpoint: storage?.endpoint || '',
    region: storage?.region || 'us-east-1',
    accessKeyId: storage?.accessKeyId || '',
    secretAccessKey: '',
    bucket: storage?.bucket || '',
    basePath: storage?.basePath || '',
    config: initConfig(storage?.type || 's3', storage?.config),
    isPublic: storage?.isPublic ?? false,
    guestList: storage?.guestList ?? false,
    guestDownload: storage?.guestDownload ?? false,
    guestUpload: storage?.guestUpload ?? false,
    description: storage?.description || '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    items?: number;
    error?: string;
  } | null>(null);
  const driveConfig = driveConfigMap[formData.type || ''];
  const isS3 = formData.type === 's3';
  const isS3Like =
    formData.type === 's3' ||
    formData.type === 'tigris' ||
    formData.type === 'qiniu';
  const isR2 = formData.type === 'r2';
  const isR2OAuth = formData.type === 'r2-oauth';
  const isFtp = formData.type === 'ftp';
  const isWebdav = formData.type === 'webdev' || isFtp;
  const isMysql = formData.type === 'mysql';

  const handleTypeChange = (nextType: string) => {
    const keepTopFields = nextType === 's3' || nextType === 'webdev';
    setFormData({
      ...formData,
      type: nextType,
      endpoint: keepTopFields ? formData.endpoint : '',
      region: keepTopFields ? formData.region : 'auto',
      accessKeyId: keepTopFields ? formData.accessKeyId : '',
      secretAccessKey: '',
      bucket: keepTopFields ? formData.bucket : '',
      basePath: keepTopFields ? formData.basePath : '',
      config: initConfig(nextType, {}),
    });
  };

  const updateConfigValue = (key: string, value: string | number | boolean) => {
    setFormData({
      ...formData,
      config: { ...(formData.config || {}), [key]: value },
    });
  };

  const renderConfigField = (field: ConfigField) => {
    const values = formData.config || {};
    if (field.show && !field.show(values)) {
      return null;
    }

    const commonClasses = 'w-full field';
    const value = values[field.key] ?? '';
    const isPasswordLike =
      field.type === 'password' ||
      field.key.includes('secret') ||
      field.key.includes('key') ||
      field.key === 'client_secret' ||
      field.key === 'refresh_token';

    if (field.type === 'boolean') {
      return (
        <label
          key={field.key}
          className="flex items-center gap-2 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => updateConfigValue(field.key, e.target.checked)}
            className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">
            {field.label}
          </span>
          {field.help && (
            <span className="text-xs text-zinc-500">{field.help}</span>
          )}
        </label>
      );
    }

    if (field.type === 'select') {
      return (
        <div key={field.key}>
          <label className="block text-xs text-zinc-500 mb-1.5">
            {field.label}
            {field.required ? ' *' : ''}
          </label>
          <select
            value={String(value)}
            onChange={(e) => updateConfigValue(field.key, e.target.value)}
            className={commonClasses}
            required={field.required}
          >
            {(field.options || []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {field.help && (
            <p className="text-xs text-zinc-500 mt-1.5">{field.help}</p>
          )}
        </div>
      );
    }

    if (field.type === 'textarea') {
      return (
        <div key={field.key}>
          <label className="block text-xs text-zinc-500 mb-1.5">
            {field.label}
            {field.required ? ' *' : ''}
            {field.link && (
              <a
                href={field.link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 underline underline-offset-2"
              >
                {field.link.text}
              </a>
            )}
          </label>
          <textarea
            value={String(value)}
            onChange={(e) => updateConfigValue(field.key, e.target.value)}
            className={`${commonClasses} h-24`}
            placeholder={field.placeholder || ''}
            required={field.required}
          />
          {field.help && (
            <p className="text-xs text-zinc-500 mt-1.5">{field.help}</p>
          )}
        </div>
      );
    }

    if (isPasswordLike) {
      return (
        <PasswordInput
          key={field.key}
          value={String(value)}
          onChange={(v) => updateConfigValue(field.key, v)}
          label={field.label}
          required={field.required}
          help={field.help}
          link={field.link}
          pattern={field.pattern}
          patternHint={field.patternHint}
        />
      );
    }

    return (
      <div key={field.key}>
        <label className="block text-xs text-zinc-500 mb-1.5">
          {field.label}
          {field.required ? ' *' : ''}
          {field.link && (
            <a
              href={field.link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 underline underline-offset-2"
            >
              {field.link.text}
            </a>
          )}
        </label>
        <input
          type={field.type}
          value={String(value)}
          onChange={(e) => updateConfigValue(field.key, e.target.value)}
          className={commonClasses}
          placeholder={field.placeholder || ''}
          required={field.required}
          pattern={field.pattern}
          title={field.patternHint}
        />
        {field.help && (
          <p className="text-xs text-zinc-500 mt-1.5">{field.help}</p>
        )}
      </div>
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const method = storage ? 'PUT' : 'POST';
      const configToSend = { ...(formData.config || {}) };
      // 服务端脱敏占位符 "***"：用户未改动的敏感字段不回传，避免覆盖真实密钥
      for (const [k, v] of Object.entries(configToSend)) {
        if (v === '***') {
          delete configToSend[k];
        }
      }
      // 被 show 条件隐藏的字段（如关闭 custom_api_base 后的 api_base）不应发送到后端
      if (driveConfig) {
        for (const field of driveConfig.fields) {
          if (field.show && !field.show(configToSend)) {
            delete configToSend[field.key];
          }
        }
      }
      if (configToSend.api_address && !configToSend.api_url_address) {
        configToSend.api_url_address = configToSend.api_address;
      }
      if (driveConfig) {
        for (const field of driveConfig.fields) {
          if (field.type === 'password' && !configToSend[field.key]) {
            delete configToSend[field.key];
          }
        }
      }
      const body = storage
        ? { id: storage.id, ...formData, config: configToSend }
        : { ...formData, config: configToSend };

      if (storage && !formData.secretAccessKey && (isS3Like || isWebdav)) {
        delete (body as Record<string, unknown>).secretAccessKey;
      }

      const res = await fetch('/api/storages', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        onSave();
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error || '保存失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  };

  // 用当前表单草稿测试连接，不落库
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test-connection',
          storageId: storage?.id || 0,
          type: formData.type,
          endpoint: formData.endpoint,
          region: formData.region,
          accessKeyId: formData.accessKeyId,
          secretAccessKey: formData.secretAccessKey,
          bucket: formData.bucket,
          basePath: formData.basePath,
          config: stripMaskedConfig(formData.config || {}),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        latencyMs?: number;
        items?: number;
        error?: string;
      };
      setTestResult({
        ok: Boolean(data.ok),
        latencyMs: data.latencyMs,
        items: data.items,
        error: data.error,
      });
    } catch {
      setTestResult({ ok: false, error: '网络错误' });
    } finally {
      setTesting(false);
    }
  };

  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState('');
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [oauthAuthorized, setOauthAuthorized] = useState(false);

  // 夸克扫码登录：弹窗内的二维码、轮询状态与定时器
  type QrStatus = 'loading' | 'waiting' | 'success' | 'expired' | 'failed';
  const [qrOpen, setQrOpen] = useState(false);
  const [qrImage, setQrImage] = useState('');
  const [qrStatus, setQrStatus] = useState<QrStatus>('loading');
  const [qrHint, setQrHint] = useState('');
  const [qrCountdown, setQrCountdown] = useState(0);
  const qrSessionRef = useRef('');
  const qrPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrAbortRef = useRef<AbortController | null>(null);

  // 百度扫码登录：弹窗内的二维码、轮询状态与定时器
  const [bdQrOpen, setBdQrOpen] = useState(false);
  const [bdQrImage, setBdQrImage] = useState('');
  const [bdQrStatus, setBdQrStatus] = useState<QrStatus>('loading');
  const [bdQrHint, setBdQrHint] = useState('');
  const [bdQrCountdown, setBdQrCountdown] = useState(0);
  const bdQrSessionRef = useRef('');
  const bdQrPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bdQrTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bdQrCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bdQrAbortRef = useRef<AbortController | null>(null);

  // 阿里云盘扫码登录：弹窗内的二维码、轮询状态与定时器
  const [alQrOpen, setAlQrOpen] = useState(false);
  const [alQrImage, setAlQrImage] = useState('');
  const [alQrStatus, setAlQrStatus] = useState<QrStatus>('loading');
  const [alQrHint, setAlQrHint] = useState('');
  const [alQrCountdown, setAlQrCountdown] = useState(0);
  const alQrSessionRef = useRef('');
  const alQrPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alQrTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const alQrCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alQrAbortRef = useRef<AbortController | null>(null);

  // gdrive 类型时查询 OAuth 配置与授权状态，用于显示按钮提示
  useEffect(() => {
    if (formData.type !== 'gdrive') {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/gdrive-oauth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'status',
            storageId: storage?.id || 0,
          }),
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          configured?: boolean;
          authorized?: boolean;
        };
        if (!cancelled) {
          setOauthConfigured(Boolean(data.configured));
          setOauthAuthorized(Boolean(data.authorized));
        }
      } catch {
        // status 仅作提示，失败静默
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formData.type, storage?.id]);

  // 发起 Google OAuth：已有存储直接跳转；新存储先落库拿到 id 再跳转
  const startGdriveAuth = async () => {
    setOauthLoading(true);
    setOauthError('');
    try {
      let storageId = storage?.id;
      if (!storageId) {
        const configToSend = { ...(formData.config || {}) };
        delete configToSend.refresh_token;
        const res = await fetch('/api/storages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...formData, config: configToSend }),
        });
        const data = (await res.json()) as {
          error?: string;
          storage?: { id?: number };
        };
        if (!res.ok || !data.storage?.id) {
          setOauthError(data.error || '保存存储失败，无法发起授权');
          setOauthLoading(false);
          return;
        }
        storageId = data.storage.id;
        onSave();
      }
      const res = await fetch('/api/gdrive-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', storageId }),
      });
      const data = (await res.json()) as { error?: string; url?: string };
      if (!res.ok || !data.url) {
        setOauthError(data.error || '发起授权失败');
        setOauthLoading(false);
        return;
      }
      const popup = window.open(
        data.url,
        '_blank',
        'popup,width=600,height=700',
      );
      if (!popup) {
        setOauthError('弹出窗口被阻止，请允许弹出窗');
        setOauthLoading(false);
        return;
      }
      const handleMessage = (e: MessageEvent) => {
        if (e.data?.type === 'oauth' && e.data.provider === 'google') {
          window.removeEventListener('message', handleMessage);
          popup.close();
          setOauthLoading(false);
          setTimeout(() => {
            onSave();
          }, 500);
        }
      };
      window.addEventListener('message', handleMessage);
    } catch {
      setOauthError('网络错误');
      setOauthLoading(false);
    }
  };

  // OneDrive OAuth：弹窗 + postMessage
  const startOneDriveAuth = async () => {
    setOauthLoading(true);
    setOauthError('');
    try {
      let storageId = storage?.id;
      if (!storageId) {
        const configToSend = { ...(formData.config || {}) };
        delete configToSend.refresh_token;
        const res = await fetch('/api/storages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...formData, config: configToSend }),
        });
        const data = (await res.json()) as {
          error?: string;
          storage?: { id?: number };
        };
        if (!res.ok || !data.storage?.id) {
          setOauthError(data.error || '保存存储失败，无法发起授权');
          setOauthLoading(false);
          return;
        }
        storageId = data.storage.id;
        onSave();
      }
      const res = await fetch('/api/onedrive-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', storageId }),
      });
      const data = (await res.json()) as { error?: string; url?: string };
      if (!res.ok || !data.url) {
        setOauthError(data.error || '发起授权失败');
        setOauthLoading(false);
        return;
      }
      const popup = window.open(
        data.url,
        '_blank',
        'popup,width=600,height=700',
      );
      if (!popup) {
        setOauthError('弹出窗口被阻止，请允许弹出窗');
        setOauthLoading(false);
        return;
      }
      const handleMessage = (e: MessageEvent) => {
        if (e.data?.type === 'oauth' && e.data.provider === 'microsoft') {
          window.removeEventListener('message', handleMessage);
          popup.close();
          setOauthLoading(false);
          setTimeout(() => {
            onSave();
          }, 500);
        }
      };
      window.addEventListener('message', handleMessage);
    } catch {
      setOauthError('网络错误');
      setOauthLoading(false);
    }
  };

  // R2 OAuth：弹窗 + postMessage
  const startR2OAuth = async () => {
    setOauthLoading(true);
    setOauthError('');
    try {
      let storageId = storage?.id;
      if (!storageId) {
        const res = await fetch('/api/storages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });
        const data = (await res.json()) as {
          error?: string;
          storage?: { id?: number };
        };
        if (!res.ok || !data.storage?.id) {
          setOauthError(data.error || '保存存储失败，无法发起授权');
          setOauthLoading(false);
          return;
        }
        storageId = data.storage.id;
        onSave();
      }
      const res = await fetch('/api/r2-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', storageId }),
      });
      const data = (await res.json()) as { error?: string; url?: string };
      if (!res.ok || !data.url) {
        setOauthError(data.error || '发起授权失败');
        setOauthLoading(false);
        return;
      }
      const popup = window.open(
        data.url,
        '_blank',
        'popup,width=600,height=700',
      );
      if (!popup) {
        setOauthError('弹出窗口被阻止，请允许弹出窗');
        setOauthLoading(false);
        return;
      }
      const handleMessage = (e: MessageEvent) => {
        if (e.data?.type === 'oauth' && e.data.provider === 'cloudflare') {
          window.removeEventListener('message', handleMessage);
          popup.close();
          setOauthLoading(false);
          setTimeout(() => {
            onSave();
          }, 500);
        }
      };
      window.addEventListener('message', handleMessage);
    } catch {
      setOauthError('网络错误');
      setOauthLoading(false);
    }
  };

  // 夸克扫码：Cookie 属于账号凭据，轮询成功后直接写回表单，不落库、不外发
  const stopQuarkQr = () => {
    if (qrPollRef.current) {
      clearTimeout(qrPollRef.current);
      qrPollRef.current = null;
    }
    if (qrTickRef.current) {
      clearInterval(qrTickRef.current);
      qrTickRef.current = null;
    }
    if (qrCloseRef.current) {
      clearTimeout(qrCloseRef.current);
      qrCloseRef.current = null;
    }
    if (qrAbortRef.current) {
      qrAbortRef.current.abort();
      qrAbortRef.current = null;
    }
  };

  const closeQuarkQr = () => {
    stopQuarkQr();
    qrSessionRef.current = '';
    setQrOpen(false);
  };

  const writeQuarkCookie = (cookie: string) => {
    // 函数式更新：轮询回调持有的是旧的 formData 快照，直接覆盖会丢掉用户其他输入
    setFormData((prev) => ({
      ...prev,
      config: { ...(prev.config || {}), cookie },
    }));

    // 同步写入后端存储，确保 QuarkClient 初始化时拿到最新 cookie
    if (storage?.id) {
      fetch('/api/storages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: storage.id,
          config: { ...(storage.config || {}), cookie },
        }),
      }).catch(() => {
        /* ignore sync failure */
      });
    }
  };

  const pollQuarkQr = async () => {
    const session = qrSessionRef.current;
    if (!session) return;

    qrAbortRef.current = new AbortController();
    let result: { status?: string; cookie?: string; message?: string };
    try {
      const res = await fetch(
        `/api/quark-qr?action=query&session=${encodeURIComponent(session)}`,
        {
          signal: qrAbortRef.current.signal,
        },
      );
      result = (await res.json()) as typeof result;
    } catch {
      result = {};
    }
    qrAbortRef.current = null;
    if (qrSessionRef.current !== session) return;

    if (result.status === 'success') {
      stopQuarkQr();
      setQrStatus('success');
      setQrHint('已获取登录 Cookie，请保存配置');
      writeQuarkCookie(result.cookie || '');
      qrCloseRef.current = setTimeout(closeQuarkQr, 1200);
      return;
    }
    if (result.status === 'expired' || result.status === 'failed') {
      stopQuarkQr();
      setQrStatus(result.status);
      setQrHint(
        result.message ||
          (result.status === 'expired' ? '二维码已过期' : '扫码登录失败'),
      );
      return;
    }
    // 未扫码/网络抖动都继续等，避免一次失败就打断用户
    setQrStatus('waiting');
    qrPollRef.current = setTimeout(pollQuarkQr, QUARK_QR_POLL_MS);
  };

  const startQuarkQr = async () => {
    stopQuarkQr();
    qrSessionRef.current = '';
    setQrImage('');
    setQrStatus('loading');
    setQrHint('正在获取二维码...');
    setQrCountdown(QUARK_QR_TTL_SEC);
    setQrOpen(true);

    try {
      const res = await fetch('/api/quark-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = (await res.json()) as {
        error?: string;
        session?: string;
        qrUrl?: string;
        expiresIn?: number;
        pollIntervalMs?: number;
      };
      if (!res.ok || !data.session || !data.qrUrl) {
        setQrStatus('failed');
        setQrHint(data.error || '获取二维码失败，请稍后重试');
        return;
      }

      try {
        const QRCode = await import('qrcode');
        // qrcode.toDataURL 可能是同步的，使用 await 确保安值
        const qrDataUrl = await QRCode.toDataURL(data.qrUrl, {
          margin: 1,
          width: 220,
        });
        setQrImage(qrDataUrl);
      } catch (e) {
        setQrStatus('failed');
        setQrHint('二维码生成失败，请稍后重试');
        return;
      }

      qrSessionRef.current = data.session;
      setQrCountdown(data.expiresIn || QUARK_QR_TTL_SEC);
      setQrStatus('waiting');
      setQrHint('打开夸克 App 扫码并确认登录');
      qrPollRef.current = setTimeout(
        pollQuarkQr,
        data.pollIntervalMs || QUARK_QR_POLL_MS,
      );
      qrTickRef.current = setInterval(() => {
        setQrCountdown((prev) => {
          if (prev <= 1) {
            stopQuarkQr();
            setQrStatus('expired');
            setQrHint('二维码已过期，请重新获取');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch {
      setQrStatus('failed');
      setQrHint('网络错误，获取二维码失败');
    }
  };

  useEffect(() => stopQuarkQr, []);

  // 百度扫码登录
  const stopBaiduQr = () => {
    if (bdQrPollRef.current) {
      clearTimeout(bdQrPollRef.current);
      bdQrPollRef.current = null;
    }
    if (bdQrTickRef.current) {
      clearInterval(bdQrTickRef.current);
      bdQrTickRef.current = null;
    }
    if (bdQrCloseRef.current) {
      clearTimeout(bdQrCloseRef.current);
      bdQrCloseRef.current = null;
    }
    if (bdQrAbortRef.current) {
      bdQrAbortRef.current.abort();
      bdQrAbortRef.current = null;
    }
  };

  const closeBaiduQr = () => {
    stopBaiduQr();
    bdQrSessionRef.current = '';
    setBdQrOpen(false);
  };

  const writeBaiduCookie = (cookie: string) => {
    setFormData((prev) => ({
      ...prev,
      config: { ...(prev.config || {}), cookie },
    }));
  };

  const pollBaiduQr = async () => {
    const session = bdQrSessionRef.current;
    if (!session) return;

    bdQrAbortRef.current = new AbortController();
    let result: { status?: string; cookie?: string; message?: string };
    try {
      const res = await fetch(
        `/api/baidu-qr?action=query&session=${encodeURIComponent(session)}`,
        {
          signal: bdQrAbortRef.current.signal,
        },
      );
      result = (await res.json()) as typeof result;
    } catch {
      result = {};
    }
    bdQrAbortRef.current = null;
    if (bdQrSessionRef.current !== session) return;

    if (result.status === 'success') {
      stopBaiduQr();
      setBdQrStatus('success');
      setBdQrHint('已获取登录 Cookie，请保存配置');
      writeBaiduCookie(result.cookie || '');
      bdQrCloseRef.current = setTimeout(closeBaiduQr, 1200);
      return;
    }
    if (result.status === 'expired' || result.status === 'failed') {
      stopBaiduQr();
      setBdQrStatus(result.status);
      setBdQrHint(
        result.message ||
          (result.status === 'expired' ? '二维码已过期' : '扫码登录失败'),
      );
      return;
    }
    setBdQrStatus('waiting');
    bdQrPollRef.current = setTimeout(pollBaiduQr, 3000);
  };

  const startBaiduQr = async () => {
    stopBaiduQr();
    bdQrSessionRef.current = '';
    setBdQrImage('');
    setBdQrStatus('loading');
    setBdQrHint('正在获取二维码...');
    setBdQrCountdown(300);
    setBdQrOpen(true);

    try {
      const res = await fetch('/api/baidu-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = (await res.json()) as {
        error?: string;
        session?: string;
        qrUrl?: string;
        expiresIn?: number;
        pollIntervalMs?: number;
      };
      if (!res.ok || !data.session || !data.qrUrl) {
        setBdQrStatus('failed');
        setBdQrHint(data.error || '获取二维码失败，请稍后重试');
        return;
      }

      setBdQrImage(data.qrUrl);
      bdQrSessionRef.current = data.session;
      setBdQrCountdown(data.expiresIn || 300);
      setBdQrStatus('waiting');
      setBdQrHint('打开百度 App 扫码并确认登录');
      bdQrPollRef.current = setTimeout(
        pollBaiduQr,
        data.pollIntervalMs || 3000,
      );
      bdQrTickRef.current = setInterval(() => {
        setBdQrCountdown((prev) => {
          if (prev <= 1) {
            stopBaiduQr();
            setBdQrStatus('expired');
            setBdQrHint('二维码已过期，请重新获取');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch {
      setBdQrStatus('failed');
      setBdQrHint('网络错误，获取二维码失败');
    }
  };

  useEffect(() => stopBaiduQr, []);

  // 阿里云盘扫码登录
  const stopAlQr = () => {
    if (alQrPollRef.current) {
      clearTimeout(alQrPollRef.current);
      alQrPollRef.current = null;
    }
    if (alQrTickRef.current) {
      clearInterval(alQrTickRef.current);
      alQrTickRef.current = null;
    }
    if (alQrCloseRef.current) {
      clearTimeout(alQrCloseRef.current);
      alQrCloseRef.current = null;
    }
    if (alQrAbortRef.current) {
      alQrAbortRef.current.abort();
      alQrAbortRef.current = null;
    }
  };

  const closeAlQr = () => {
    stopAlQr();
    alQrSessionRef.current = '';
    setAlQrOpen(false);
  };

  const pollAlQr = async () => {
    const session = alQrSessionRef.current;
    if (!session) return;

    alQrAbortRef.current = new AbortController();
    let result: { status?: string; code?: string; message?: string };
    try {
      const res = await fetch(
        `/api/alicloud-qr?action=query&session=${encodeURIComponent(session)}`,
        {
          signal: alQrAbortRef.current.signal,
        },
      );
      result = (await res.json()) as typeof result;
    } catch {
      result = {};
    }
    alQrAbortRef.current = null;
    if (alQrSessionRef.current !== session) return;

    if (result.status === 'success' && result.code) {
      const clientId = formData.config?.client_id || '';
      const clientSecret = formData.config?.client_secret || '';
      if (!clientId || !clientSecret) {
        setAlQrStatus('failed');
        setAlQrHint('缺少 client_id 或 client_secret，请先在配置中填写');
        return;
      }
      try {
        const res = await fetch('/api/alicloud-qr/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          refresh_token?: string;
        };
        if (!res.ok || !data.refresh_token) {
          stopAlQr();
          setAlQrStatus('failed');
          setAlQrHint(data.error || '兑换令牌失败，请重试');
          return;
        }
        stopAlQr();
        setAlQrStatus('success');
        setAlQrHint('已获取令牌，请保存配置');
        setFormData((prev) => ({
          ...prev,
          config: {
            ...(prev.config || {}),
            refresh_token: data.refresh_token,
          },
        }));
        alQrCloseRef.current = setTimeout(closeAlQr, 1200);
        return;
      } catch {
        stopAlQr();
        setAlQrStatus('failed');
        setAlQrHint('兑换令牌失败，请重试');
        return;
      }
    }
    if (result.status === 'expired' || result.status === 'failed') {
      stopAlQr();
      setAlQrStatus(result.status);
      setAlQrHint(
        result.message ||
          (result.status === 'expired' ? '二维码已过期' : '扫码登录失败'),
      );
      return;
    }
    setAlQrStatus('waiting');
    alQrPollRef.current = setTimeout(pollAlQr, 3000);
  };

  const startAlQr = async () => {
    stopAlQr();
    alQrSessionRef.current = '';
    setAlQrImage('');
    setAlQrStatus('loading');
    setAlQrHint('正在获取二维码...');
    setAlQrCountdown(300);
    setAlQrOpen(true);

    try {
      const clientId = formData.config?.client_id || '';
      if (!clientId) {
        setAlQrStatus('failed');
        setAlQrHint('请先在配置中填写客户端ID（client_id）');
        return;
      }
      const res = await fetch('/api/alicloud-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', client_id: clientId }),
      });
      const data = (await res.json()) as {
        error?: string;
        session?: string;
        qrUrl?: string;
        expiresIn?: number;
        pollIntervalMs?: number;
      };
      if (!res.ok || !data.session || !data.qrUrl) {
        setAlQrStatus('failed');
        setAlQrHint(data.error || '获取二维码失败，请稍后重试');
        return;
      }

      setAlQrImage(data.qrUrl);
      alQrSessionRef.current = data.session;
      setAlQrCountdown(data.expiresIn || 300);
      setAlQrStatus('waiting');
      setAlQrHint('打开阿里云盘 App 扫码并确认登录');
      alQrPollRef.current = setTimeout(pollAlQr, data.pollIntervalMs || 3000);
      alQrTickRef.current = setInterval(() => {
        setAlQrCountdown((prev) => {
          if (prev <= 1) {
            stopAlQr();
            setAlQrStatus('expired');
            setAlQrHint('二维码已过期，请重新获取');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch {
      setAlQrStatus('failed');
      setAlQrHint('网络错误，获取二维码失败');
    }
  };

  useEffect(() => stopAlQr, []);

  // OneDrive OAuth 配置状态查询
  useEffect(() => {
    if (formData.type !== 'onedrive') {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/onedrive-oauth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'status',
            storageId: storage?.id || 0,
          }),
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as {
          configured?: boolean;
          authorized?: boolean;
        };
        if (!cancelled) {
          setOauthConfigured(Boolean(data.configured));
          setOauthAuthorized(Boolean(data.authorized));
        }
      } catch {
        // status 仅作提示，失败静默
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formData.type, storage?.id]);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        onClick={onCancel}
      >
        <div
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between sticky top-0 bg-white dark:bg-zinc-900 rounded-t-lg">
            <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">
              {storage ? '编辑存储' : '添加存储'}
            </span>
            <button
              onClick={onCancel}
              className="icon-btn h-7 w-7"
              aria-label="关闭"
            >
              <X />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-xs text-zinc-500 mb-1.5">
                  名称 *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full field"
                  placeholder="My Storage"
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-zinc-500 mb-1.5">
                  描述
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  className="w-full field"
                  placeholder="可选：存储的简短描述"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-zinc-500 mb-1.5">
                  存储类型 *
                </label>
                <select
                  value={formData.type}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  className="w-full field"
                  required
                >
                  <option value="s3">S3 兼容服务</option>
                  <option value="webdev">WebDAV</option>
                  <option value="onedrive">OneDrive</option>
                  <option value="gdrive">Google Drive</option>
                  <option value="tigris">Tigris 对象存储</option>
                  <option value="qiniu">七牛云 KODO</option>
                  <option value="alicloud">阿里云盘</option>
                  <option value="baiduyun">百度网盘</option>
                  <option value="quark">夸克网盘</option>
                  <option value="r2">Cloudflare R2</option>
                  <option value="r2-oauth">R2 存储桶（他人 OAuth）</option>
                  <option value="ftp">FTP 文件网关</option>
                  <option value="mysql">MySQL 数据库</option>
                  <option value="dropbox">Dropbox</option>
                  <option value="github">GitHub 仓库</option>
                  <option value="gitlab">GitLab 仓库</option>
                  <option value="gitea">Gitea / Forgejo 仓库</option>
                  <option value="gitee">Gitee 仓库</option>
                </select>
              </div>
              {(isS3 || isWebdav) && (
                <div className="col-span-2">
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    {isWebdav ? 'WebDAV 服务器地址' : 'Endpoint'} *
                  </label>
                  <input
                    type="url"
                    value={formData.endpoint}
                    onChange={(e) =>
                      setFormData({ ...formData, endpoint: e.target.value })
                    }
                    className="w-full field"
                    placeholder={
                      isWebdav
                        ? 'https://example.com/webdav'
                        : 'https://s3.us-east-1.amazonaws.com'
                    }
                    required
                  />
                  {isWebdav && (
                    <p className="text-xs text-zinc-500 mt-1.5">
                      WebDAV
                      用户名/密码由你的服务器（Nginx/Apache/Nextcloud/坚果云）生成，参见{' '}
                      <code className="text-zinc-700 dark:text-zinc-300">
                        docs/WEBDAV_SETUP.md
                      </code>
                      。
                    </p>
                  )}
                  {isS3 && (
                    <p className="text-xs text-zinc-500 mt-1.5">
                      Endpoint 从对象存储控制台复制；AWS 形如{' '}
                      <code className="text-zinc-700 dark:text-zinc-300">
                        https://s3.地区.amazonaws.com
                      </code>
                      ， R2 形如{' '}
                      <code className="text-zinc-700 dark:text-zinc-300">
                        https://account_id.r2.cloudflarestorage.com
                      </code>
                      。
                    </p>
                  )}
                </div>
              )}
              {isS3 && (
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    Region
                  </label>
                  <input
                    type="text"
                    value={formData.region}
                    onChange={(e) =>
                      setFormData({ ...formData, region: e.target.value })
                    }
                    className="w-full field"
                    placeholder="auto"
                  />
                </div>
              )}
              {isS3 && (
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    Bucket *
                  </label>
                  <input
                    type="text"
                    value={formData.bucket}
                    onChange={(e) =>
                      setFormData({ ...formData, bucket: e.target.value })
                    }
                    className="w-full field"
                    placeholder="my-bucket"
                    required={isS3}
                  />
                </div>
              )}
              {isS3 && (
                <div className="col-span-2 space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.config?.path_style !== false}
                      onChange={(e) =>
                        updateConfigValue('path_style', e.target.checked)
                      }
                      className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                    />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      路径风格访问 (Path Style)
                    </span>
                  </label>
                  <p className="text-xs text-zinc-500">
                    自建/MinIO/R2 兼容端点通常需要勾选路径风格；虚拟主机风格按
                    <code className="text-zinc-700 dark:text-zinc-300">
                      bucket.endpoint/key
                    </code>{' '}
                    访问。
                  </p>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      签名版本
                    </label>
                    <select
                      value={formData.config?.signature_version ?? 'v4'}
                      onChange={(e) =>
                        updateConfigValue('signature_version', e.target.value)
                      }
                      className="w-full field"
                    >
                      <option value="v4">SigV4 (AWS4-HMAC-SHA256)</option>
                      <option value="v2">
                        SigV2 (AWS-HMAC-SHA1, 旧版兼容)
                      </option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      会话令牌 (Session Token)
                    </label>
                    <input
                      type="password"
                      value={formData.config?.session_token ?? ''}
                      onChange={(e) =>
                        updateConfigValue('session_token', e.target.value)
                      }
                      className="w-full field"
                      placeholder="可选：STS 临时凭证 Security Token"
                    />
                  </div>
                </div>
              )}
              {(isS3 || isWebdav) && (
                <>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      {isWebdav ? '用户名' : 'Access Key'} *
                    </label>
                    <input
                      type="text"
                      value={formData.accessKeyId}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          accessKeyId: e.target.value,
                        })
                      }
                      className="w-full field"
                      required={!storage && (isS3 || isWebdav)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      {isWebdav ? '密码' : 'Secret Key'}{' '}
                      {storage && '(留空保持)'}
                    </label>
                    <input
                      type="password"
                      value={formData.secretAccessKey}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          secretAccessKey: e.target.value,
                        })
                      }
                      className="w-full field"
                      required={!storage && (isS3 || isWebdav)}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      根路径
                    </label>
                    <input
                      type="text"
                      value={formData.basePath}
                      onChange={(e) =>
                        setFormData({ ...formData, basePath: e.target.value })
                      }
                      className="w-full field"
                      placeholder="/path/to/folder"
                    />
                  </div>
                </>
              )}
              {isR2 && (
                <div className="col-span-2">
                  <div className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded p-2.5 leading-relaxed">
                    使用部署时 wrangler 配置的{' '}
                    <code className="text-zinc-700 dark:text-zinc-300">
                      r2_buckets
                    </code>{' '}
                    绑定， 无需填写密钥。部署了 R2
                    绑定后系统会自动挂载，这里可手动添加或调整根路径。
                  </div>
                  <a
                    href="https://developers.cloudflare.com/r2/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 underline underline-offset-2 mt-2 inline-block"
                  >
                    Cloudflare R2 文档 →
                  </a>
                  <label className="block text-xs text-zinc-500 mb-1.5 mt-3">
                    根路径（可选）
                  </label>
                  <input
                    type="text"
                    value={formData.basePath}
                    onChange={(e) =>
                      setFormData({ ...formData, basePath: e.target.value })
                    }
                    className="w-full field"
                    placeholder="/photos"
                  />
                </div>
              )}
              {isMysql && (
                <div className="col-span-2">
                  <div className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded p-2.5 leading-relaxed">
                    MySQL 数据库通过 Cloudflare Hyperdrive 接入：先在控制台创建
                    Hyperdrive 并绑定到 Worker（
                    <code className="text-zinc-700 dark:text-zinc-300">
                      wrangler.jsonc
                    </code>{' '}
                    的
                    <code className="text-zinc-700 dark:text-zinc-300">
                      {' '}
                      hyperdrive
                    </code>{' '}
                    配置），然后只需填写 数据库名即可浏览表和查询数据。未绑定
                    Hyperdrive 时可填直连连接串（仅本地/开发场景）。
                  </div>
                </div>
              )}
              {isR2OAuth && (
                <div className="col-span-2">
                  <div className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded p-2.5 leading-relaxed">
                    通过 Cloudflare OAuth 授权访问他人的 R2 存储桶。需要在
                    wrangler 配置 CF_CLIENT_ID / CF_CLIENT_SECRET，详见
                    docs/DEPLOY_SECRETS.md。
                  </div>
                  <a
                    href="https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 underline underline-offset-2 mt-2 inline-block"
                  >
                    创建 OAuth 客户端 →
                  </a>
                  <button
                    type="button"
                    onClick={startR2OAuth}
                    disabled={oauthLoading}
                    className="mt-2 w-full py-2 px-3 text-sm rounded border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition disabled:opacity-50"
                  >
                    {oauthLoading ? '跳转中...' : '通过 Cloudflare 授权'}
                  </button>
                  {oauthError && (
                    <div className="text-red-500 dark:text-red-400 text-xs font-medium mt-1">
                      {oauthError}
                    </div>
                  )}
                </div>
              )}
              {driveConfig && (
                <div className="col-span-2 border-t border-zinc-200 dark:border-zinc-700 pt-3 mt-1">
                  <div className="text-xs text-zinc-500 mb-2 font-medium">
                    驱动配置 - {driveConfig.name}
                  </div>
                  <div className="space-y-3">
                    {driveConfig.fields.map(renderConfigField)}
                  </div>
                  {formData.type === 'gdrive' && (
                    <div className="pt-1 space-y-2">
                      <div className="text-xs text-zinc-500 leading-relaxed">
                        {oauthConfigured
                          ? oauthAuthorized
                            ? '已通过 Google 授权，刷新令牌已保存'
                            : '尚未授权，点击下方按钮跳转 Google 完成授权'
                          : '未配置 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，可手动填写下方刷新令牌'}
                      </div>
                      <button
                        type="button"
                        onClick={startGdriveAuth}
                        disabled={oauthLoading}
                        className="w-full py-2 px-3 text-sm rounded border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition disabled:opacity-50"
                      >
                        {oauthLoading ? '跳转中...' : '通过 Google 授权'}
                      </button>
                      {oauthError && (
                        <div className="text-red-500 dark:text-red-400 text-xs font-medium">
                          {oauthError}
                        </div>
                      )}
                    </div>
                  )}
                  {formData.type === 'onedrive' && (
                    <div className="pt-1 space-y-2">
                      <div className="text-xs text-zinc-500 leading-relaxed">
                        {oauthConfigured
                          ? oauthAuthorized
                            ? '已通过 Microsoft 授权，刷新令牌已保存'
                            : '尚未授权，点击下方按钮跳转 Microsoft 完成授权'
                          : '未配置 ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET，可手动填写下方刷新令牌'}
                      </div>
                      <button
                        type="button"
                        onClick={startOneDriveAuth}
                        disabled={oauthLoading}
                        className="w-full py-2 px-3 text-sm rounded border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition disabled:opacity-50"
                      >
                        {oauthLoading ? '跳转中...' : '通过 Microsoft 授权'}
                      </button>
                      {oauthError && (
                        <div className="text-red-500 dark:text-red-400 text-xs font-medium">
                          {oauthError}
                        </div>
                      )}
                    </div>
                  )}
                  {formData.type === 'quark' && (
                    <div className="pt-1 space-y-2">
                      <div className="text-xs text-zinc-500 leading-relaxed">
                        不必手动 F12 抓包：扫码确认后系统会自动取回登录 Cookie
                        并填入下方输入框。
                      </div>
                      <button
                        type="button"
                        onClick={startQuarkQr}
                        className="w-full py-2 px-3 text-sm rounded border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition inline-flex items-center justify-center gap-1.5"
                      >
                        <QrCode className="w-4 h-4" />
                        扫码登录获取 Cookie
                      </button>
                    </div>
                  )}
                  {formData.type === 'baiduyun' && (
                    <div className="pt-1 space-y-2">
                      <div className="text-xs text-zinc-500 leading-relaxed">
                        不必手动 F12 抓包：扫码确认后系统会自动取回登录 Cookie
                        并填入下方输入框。
                      </div>
                      <button
                        type="button"
                        onClick={startBaiduQr}
                        className="w-full py-2 px-3 text-sm rounded border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition inline-flex items-center justify-center gap-1.5"
                      >
                        <QrCode className="w-4 h-4" />
                        扫码登录获取 Cookie
                      </button>
                    </div>
                  )}
                  {formData.type === 'alicloud' && (
                    <div className="pt-1 space-y-2">
                      <div className="text-xs text-zinc-500 leading-relaxed">
                        开启「使用在线API」时扫码即可自动获取令牌；本地模式需先填写
                        client_id 与 client_secret。
                      </div>
                      <button
                        type="button"
                        onClick={startAlQr}
                        className="w-full py-2 px-3 text-sm rounded border border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition inline-flex items-center justify-center gap-1.5"
                      >
                        <QrCode className="w-4 h-4" />
                        扫码登录获取令牌
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isPublic}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setFormData({
                        ...formData,
                        isPublic: checked,
                        guestList: checked,
                        guestDownload: checked,
                      });
                    }}
                    className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    公开访问
                  </span>
                  <span className="text-xs text-zinc-500">
                    (快速开启浏览和下载)
                  </span>
                </label>
              </div>
              <div className="col-span-2 border-t border-zinc-200 dark:border-zinc-700 pt-3 mt-1">
                <div className="text-xs text-zinc-500 mb-2 font-medium">
                  游客权限设置
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.guestList}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          guestList: e.target.checked,
                        })
                      }
                      className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                    />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      允许浏览
                    </span>
                    <span className="text-xs text-zinc-500">
                      (查看文件列表)
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.guestDownload}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          guestDownload: e.target.checked,
                        })
                      }
                      className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                    />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      允许下载
                    </span>
                    <span className="text-xs text-zinc-500">
                      (下载和预览文件)
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.guestUpload}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          guestUpload: e.target.checked,
                        })
                      }
                      className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                    />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">
                      允许上传
                    </span>
                    <span className="text-xs text-zinc-500">(上传新文件)</span>
                  </label>
                </div>
              </div>
            </div>
            {error && (
              <div className="text-red-500 dark:text-red-400 text-xs font-medium">
                {error}
              </div>
            )}
            {testResult && (
              <div
                className={`text-xs rounded p-2.5 leading-relaxed ${testResult.ok ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-950 text-red-500 dark:text-red-400'}`}
              >
                {testResult.ok
                  ? `连接成功，耗时 ${testResult.latencyMs}ms，根目录 ${testResult.items} 项`
                  : `连接失败：${testResult.error || '未知错误'}`}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 py-2 px-4 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm transition rounded"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing || loading}
                className="py-2 px-3 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm transition rounded disabled:opacity-50"
              >
                {testing ? '测试中...' : '测试连接'}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 transition rounded"
              >
                {loading ? '保存中...' : '保存'}
              </button>
            </div>
          </form>
        </div>
      </div>
      {qrOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
          onClick={closeQuarkQr}
          role="dialog"
          aria-modal="true"
          aria-label="夸克扫码登录"
        >
          <div
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-xs rounded-xl shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <Smartphone className="w-4 h-4" aria-hidden="true" />
                夸克扫码登录
              </span>
              <button
                onClick={closeQuarkQr}
                className="icon-btn h-7 w-7"
                aria-label="关闭扫码弹窗"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="relative aspect-square rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white flex items-center justify-center overflow-hidden">
              {qrImage ? (
                <img
                  src={qrImage}
                  alt="夸克登录二维码，请使用夸克 App 扫码"
                  className="w-full h-full object-contain p-2"
                />
              ) : (
                <RefreshCw
                  className={`w-6 h-6 text-zinc-400 ${qrStatus === 'loading' ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              )}
              {(qrStatus === 'expired' || qrStatus === 'failed') && (
                <div className="absolute inset-0 bg-white/95 dark:bg-zinc-900/95 flex flex-col items-center justify-center gap-3 px-4">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300 text-center leading-relaxed">
                    {qrHint}
                  </span>
                  <button
                    type="button"
                    onClick={startQuarkQr}
                    className="py-1.5 px-3 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
                  >
                    重新获取二维码
                  </button>
                </div>
              )}
            </div>

            <div
              className="mt-3 text-xs text-center leading-relaxed"
              role="status"
              aria-live="polite"
            >
              {qrStatus === 'success' ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  {qrHint}
                </span>
              ) : qrStatus === 'waiting' || qrStatus === 'loading' ? (
                <span className="text-zinc-500">
                  {qrHint}
                  {qrStatus === 'waiting' && (
                    <span className="ml-1 text-zinc-400">
                      {qrCountdown}s 后过期
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-red-500 dark:text-red-400">{qrHint}</span>
              )}
            </div>
          </div>
        </div>
      )}
      {bdQrOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
          onClick={closeBaiduQr}
          role="dialog"
          aria-modal="true"
          aria-label="百度扫码登录"
        >
          <div
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-xs rounded-xl shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <Smartphone className="w-4 h-4" aria-hidden="true" />
                百度扫码登录
              </span>
              <button
                onClick={closeBaiduQr}
                className="icon-btn h-7 w-7"
                aria-label="关闭扫码弹窗"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="relative aspect-square rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white flex items-center justify-center overflow-hidden">
              {bdQrImage ? (
                <img
                  src={bdQrImage}
                  alt="百度登录二维码，请使用百度 App 扫码"
                  className="w-full h-full object-contain p-2"
                />
              ) : (
                <RefreshCw
                  className={`w-6 h-6 text-zinc-400 ${bdQrStatus === 'loading' ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              )}
              {(bdQrStatus === 'expired' || bdQrStatus === 'failed') && (
                <div className="absolute inset-0 bg-white/95 dark:bg-zinc-900/95 flex flex-col items-center justify-center gap-3 px-4">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300 text-center leading-relaxed">
                    {bdQrHint}
                  </span>
                  <button
                    type="button"
                    onClick={startBaiduQr}
                    className="py-1.5 px-3 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
                  >
                    重新获取二维码
                  </button>
                </div>
              )}
            </div>

            <div
              className="mt-3 text-xs text-center leading-relaxed"
              role="status"
              aria-live="polite"
            >
              {bdQrStatus === 'success' ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  {bdQrHint}
                </span>
              ) : bdQrStatus === 'waiting' || bdQrStatus === 'loading' ? (
                <span className="text-zinc-500">
                  {bdQrHint}
                  {bdQrStatus === 'waiting' && (
                    <span className="ml-1 text-zinc-400">
                      {bdQrCountdown}s 后过期
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-red-500 dark:text-red-400">
                  {bdQrHint}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      {alQrOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
          onClick={closeAlQr}
          role="dialog"
          aria-modal="true"
          aria-label="阿里云盘扫码登录"
        >
          <div
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-xs rounded-xl shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <Smartphone className="w-4 h-4" aria-hidden="true" />
                阿里云盘扫码登录
              </span>
              <button
                onClick={closeAlQr}
                className="icon-btn h-7 w-7"
                aria-label="关闭扫码弹窗"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="relative aspect-square rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white flex items-center justify-center overflow-hidden">
              {alQrImage ? (
                <img
                  src={alQrImage}
                  alt="阿里云盘登录二维码，请使用阿里云盘 App 扫码"
                  className="w-full h-full object-contain p-2"
                />
              ) : (
                <RefreshCw
                  className={`w-6 h-6 text-zinc-400 ${alQrStatus === 'loading' ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              )}
              {(alQrStatus === 'expired' || alQrStatus === 'failed') && (
                <div className="absolute inset-0 bg-white/95 dark:bg-zinc-900/95 flex flex-col items-center justify-center gap-3 px-4">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300 text-center leading-relaxed">
                    {alQrHint}
                  </span>
                  <button
                    type="button"
                    onClick={startAlQr}
                    className="py-1.5 px-3 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition"
                  >
                    重新获取二维码
                  </button>
                </div>
              )}
            </div>

            <div
              className="mt-3 text-xs text-center leading-relaxed"
              role="status"
              aria-live="polite"
            >
              {alQrStatus === 'success' ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  {alQrHint}
                </span>
              ) : alQrStatus === 'waiting' || alQrStatus === 'loading' ? (
                <span className="text-zinc-500">
                  {alQrHint}
                  {alQrStatus === 'waiting' && (
                    <span className="ml-1 text-zinc-400">
                      {alQrCountdown}s 后过期
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-red-500 dark:text-red-400">
                  {alQrHint}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SettingsModal({
  onClose,
  siteTitle,
  siteAnnouncement,
  isDark,
  onToggleTheme,
  isAdmin,
  onRefreshStorages,
  webdavEnabled,
  storages,
}: {
  onClose: () => void;
  siteTitle: string;
  siteAnnouncement: string;
  isDark: boolean;
  onToggleTheme: (e: React.MouseEvent) => void;
  isAdmin: boolean;
  onRefreshStorages: () => void;
  webdavEnabled: boolean;
  storages: StorageInfo[];
}) {
  const [activeTab, setActiveTab] = useState<
    'general' | 'webdav' | 'backup' | 'audit' | 'about'
  >('general');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importResult, setImportResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const toast = useToast();

  const handleExportBackup = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export-backup' }),
      });

      if (res.ok) {
        const data = (await res.json()) as { backup: unknown };
        const blob = new Blob([JSON.stringify(data.backup, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `clist-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('备份已导出', 'success');
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '导出失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (!backup.storages || !Array.isArray(backup.storages)) {
        setImportResult({ success: false, message: '无效的备份文件格式' });
        return;
      }

      const res = await fetch('/api/storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'import-backup',
          backup,
          mode: importMode,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        imported?: number;
        skipped?: number;
        errors?: string[];
        error?: string;
      };

      if (res.ok && data.success) {
        let message = `成功导入 ${data.imported} 个存储`;
        if (data.skipped && data.skipped > 0) {
          message += `，跳过 ${data.skipped} 个已存在的存储`;
        }
        if (data.errors && data.errors.length > 0) {
          message += `\n\n错误:\n${data.errors.join('\n')}`;
        }
        setImportResult({ success: true, message });
        onRefreshStorages();
      } else {
        setImportResult({ success: false, message: data.error || '导入失败' });
      }
    } catch (err) {
      setImportResult({
        success: false,
        message: err instanceof Error ? err.message : '解析备份文件失败',
      });
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  const fetchAuditLogs = async () => {
    setAuditLoading(true);
    setAuditError('');
    try {
      const res = await fetch('/api/audit?limit=200');
      if (res.ok) {
        const data = (await res.json()) as { logs?: AuditLog[] };
        setAuditLogs(data.logs || []);
      } else {
        const data = (await res.json()) as { error?: string };
        setAuditError(data.error || '加载审计日志失败');
      }
    } catch {
      setAuditError('网络错误');
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'audit' && isAdmin) {
      fetchAuditLogs();
    }
  }, [activeTab, isAdmin]);

  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-md rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">
            设置
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-200 dark:border-zinc-700">
          <button
            onClick={() => setActiveTab('general')}
            className={`flex-1 px-4 py-2 text-xs font-medium transition ${
              activeTab === 'general'
                ? 'text-blue-500 border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            常规
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveTab('webdav')}
              className={`flex-1 px-4 py-2 text-xs font-medium transition ${
                activeTab === 'webdav'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }`}
            >
              WebDAV
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveTab('backup')}
              className={`flex-1 px-4 py-2 text-xs font-medium transition ${
                activeTab === 'backup'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }`}
            >
              备份
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveTab('audit')}
              className={
                activeTab === 'audit'
                  ? 'flex-1 px-4 py-2 text-xs font-medium transition text-blue-500 border-b-2 border-blue-500'
                  : 'flex-1 px-4 py-2 text-xs font-medium transition text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }
            >
              审计
            </button>
          )}
          <button
            onClick={() => setActiveTab('about')}
            className={`flex-1 px-4 py-2 text-xs font-medium transition ${
              activeTab === 'about'
                ? 'text-blue-500 border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            关于
          </button>
        </div>

        <div className="p-4">
          {activeTab === 'general' && (
            <div className="space-y-4">
              {/* Theme Setting */}
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold">
                    主题模式
                  </div>
                  <div className="text-xs text-zinc-500">
                    切换亮色或暗色主题
                  </div>
                </div>
                <button
                  onClick={onToggleTheme}
                  className="px-3 py-1.5 text-xs font-medium rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition"
                >
                  {isDark ? '☀ 亮色' : '☾ 暗色'}
                </button>
              </div>

              {/* Announcement */}
              {siteAnnouncement && (
                <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2 flex items-center gap-2">
                    <span className="text-yellow-500">📢</span> 公告
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono whitespace-pre-wrap bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700 max-h-32 overflow-y-auto">
                    {siteAnnouncement}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'webdav' && isAdmin && (
            <div className="space-y-4">
              {/* WebDAV Status */}
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold">
                    WebDAV 服务
                  </div>
                  <div className="text-xs text-zinc-500">
                    通过 WebDAV 协议访问存储
                  </div>
                </div>
                <span
                  className={`px-2 py-1 text-xs font-medium rounded ${
                    webdavEnabled
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {webdavEnabled ? '已启用' : '未启用'}
                </span>
              </div>

              {webdavEnabled ? (
                <>
                  {/* WebDAV URL */}
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">
                      访问地址
                    </div>
                    <div className="text-xs text-zinc-500 mb-3">
                      使用 WebDAV 客户端连接以下地址访问存储
                    </div>
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700">
                      <div className="text-xs text-zinc-500 mb-1.5">
                        根目录 (所有存储):
                      </div>
                      <code className="text-sm text-blue-600 dark:text-blue-400 font-mono break-all">
                        {typeof window !== 'undefined'
                          ? `${window.location.origin}/dav/0/`
                          : '/dav/0/'}
                      </code>
                    </div>
                  </div>

                  {/* Storage List with WebDAV URLs */}
                  {storages.length > 0 && (
                    <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                      <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">
                        存储访问地址
                      </div>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {storages.map((storage) => (
                          <div
                            key={storage.id}
                            className="bg-zinc-50 dark:bg-zinc-800 p-2 rounded border border-zinc-200 dark:border-zinc-700"
                          >
                            {storage.description && (
                              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                                {storage.description}
                              </div>
                            )}
                            <div className="text-xs text-zinc-700 dark:text-zinc-300 font-mono mb-1">
                              {storage.name}
                            </div>
                            <code className="text-xs text-blue-600 dark:text-blue-400 font-mono break-all">
                              {typeof window !== 'undefined'
                                ? `${window.location.origin}/dav/${storage.id}/`
                                : `/dav/${storage.id}/`}
                            </code>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Authentication Info */}
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">
                      认证方式
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-1">
                      <p>• 协议: HTTP Basic Authentication</p>
                      <p>
                        • 用户名/密码: 使用 WEBDAV_USERNAME/WEBDAV_PASSWORD
                        环境变量配置
                      </p>
                      <p>
                        • 默认: 使用管理员账号密码
                        (ADMIN_USERNAME/ADMIN_PASSWORD)
                      </p>
                    </div>
                  </div>

                  {/* Usage Tips */}
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2 flex items-center gap-2">
                      <span className="text-blue-500">💡</span> 使用提示
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-1">
                      <p>• Windows: 映射网络驱动器，输入 WebDAV 地址</p>
                      <p>• macOS: Finder → 前往 → 连接服务器</p>
                      <p>• Linux: 使用 davfs2 或文件管理器</p>
                      <p>• 移动端: 使用支持 WebDAV 的文件管理 App</p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                  <div className="text-xs text-zinc-500 font-medium space-y-2">
                    <p>
                      WebDAV 服务未启用。要启用 WebDAV，请在 Cloudflare Workers
                      环境变量中设置:
                    </p>
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700 mt-2">
                      <code className="text-xs text-zinc-700 dark:text-zinc-300">
                        WEBDAV_ENABLED = "true"
                      </code>
                    </div>
                    <p className="mt-2">可选配置:</p>
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700">
                      <code className="text-xs text-zinc-700 dark:text-zinc-300 block">
                        WEBDAV_USERNAME = "your_username"
                      </code>
                      <code className="text-xs text-zinc-700 dark:text-zinc-300 block">
                        WEBDAV_PASSWORD = "your_password"
                      </code>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'backup' && isAdmin && (
            <div className="space-y-4">
              {/* Export Section */}
              <div>
                <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">
                  导出备份
                </div>
                <div className="text-xs text-zinc-500 mb-3">
                  导出所有存储配置到 JSON 文件，包含连接凭证信息。
                </div>
                <button
                  onClick={handleExportBackup}
                  disabled={exporting}
                  className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 transition rounded"
                >
                  {exporting ? '导出中...' : '导出备份文件'}
                </button>
              </div>

              {/* Import Section */}
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">
                  恢复备份
                </div>
                <div className="text-xs text-zinc-500 mb-3">
                  从备份文件恢复存储配置。
                </div>

                {/* Import Mode Selection */}
                <div className="mb-3">
                  <div className="text-xs text-zinc-500 mb-2 font-medium">
                    导入模式:
                  </div>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        value="merge"
                        checked={importMode === 'merge'}
                        onChange={() => setImportMode('merge')}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">
                        合并
                      </span>
                      <span className="text-xs text-zinc-500">(保留现有)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        value="replace"
                        checked={importMode === 'replace'}
                        onChange={() => setImportMode('replace')}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">
                        替换
                      </span>
                      <span className="text-xs text-zinc-500">(清空现有)</span>
                    </label>
                  </div>
                </div>

                <label
                  className={`block w-full py-2 px-4 text-center border-2 border-dashed border-zinc-300 dark:border-zinc-600 hover:border-blue-500 dark:hover:border-blue-500 text-sm cursor-pointer transition rounded ${importing ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  {importing ? '导入中...' : '选择备份文件'}
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleImportBackup}
                    className="hidden"
                    disabled={importing}
                  />
                </label>

                {/* Import Result */}
                {importResult && (
                  <div
                    className={`mt-3 p-3 rounded text-xs font-medium whitespace-pre-wrap ${
                      importResult.success
                        ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'
                        : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
                    }`}
                  >
                    {importResult.message}
                  </div>
                )}
              </div>

              {/* Warning */}
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                <div className="text-xs text-yellow-600 dark:text-yellow-500 font-mono flex items-start gap-2">
                  <span>⚠</span>
                  <span>备份文件包含敏感凭证信息，请妥善保管。</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'audit' && isAdmin && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold">
                  审计日志
                </div>
                <button
                  onClick={fetchAuditLogs}
                  disabled={auditLoading}
                  className="px-3 py-1 text-xs font-medium rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-50 transition"
                >
                  {auditLoading ? '加载中...' : '刷新'}
                </button>
              </div>
              {auditError && (
                <div className="text-xs text-red-500 dark:text-red-400 font-mono">
                  {auditError}
                </div>
              )}
              {!auditError && auditLogs.length === 0 && !auditLoading && (
                <div className="text-xs text-zinc-500 font-medium">
                  暂无日志
                </div>
              )}
              {auditLogs.length > 0 && (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="border border-zinc-200 dark:border-zinc-700 rounded p-2 bg-zinc-50 dark:bg-zinc-800/50"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-500 font-medium">
                          {formatDate(log.createdAt)}
                        </span>
                        <span className="text-[11px] text-zinc-400 font-mono">
                          {log.userType}
                        </span>
                      </div>
                      <div className="text-xs text-zinc-800 dark:text-zinc-200 font-mono">
                        {log.action}
                      </div>
                      <div className="text-[11px] text-zinc-500 font-mono">
                        {log.storageId
                          ? `storage #${log.storageId}`
                          : 'storage -'}
                        {log.path ? ` / ${log.path}` : ''}
                      </div>
                      {log.detail && (
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono mt-1 break-all">
                          {log.detail}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'about' && (
            <div className="space-y-4">
              <div className="text-center py-4">
                <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 font-semibold mb-1">
                  {siteTitle}
                </div>
                <div className="text-xs text-zinc-500 font-medium">v1.2.0</div>
              </div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-2">
                <p>S3 兼容存储聚合服务</p>
                <p className="text-zinc-500">
                  支持: AWS S3 / Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / MinIO
                  / WebDAV / OneDrive / Google Drive / 阿里云盘 / 百度网盘
                </p>
              </div>
              <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4 text-xs text-zinc-500 font-medium">
                <p>Powered by Cloudflare Workers</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AnnouncementModal({
  announcement,
  onClose,
}: {
  announcement: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-lg rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="text-yellow-500">📢</span> 公告
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
            {announcement}
          </p>
        </div>
        <div className="px-4 pb-4">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}

interface StorageStats {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  typeDistribution: Record<string, { count: number; size: number }>;
}

const chartColors = [
  '#2563eb',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#84cc16',
  '#ec4899',
  '#64748b',
  '#14b8a6',
];

function buildConicGradient(
  items: Array<{ percentage: number; color: string }>,
): string {
  if (items.length === 0) {
    return 'conic-gradient(#d4d4d8 0deg 360deg)';
  }
  let start = 0;
  const stops = items.map((item) => {
    const end = start + item.percentage * 3.6;
    const stop = `${item.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    start = end;
    return stop;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function StorageStatsModal({
  storage,
  onClose,
}: {
  storage: StorageInfo;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`/api/storage-stats/${storage.id}`);
        if (res.ok) {
          const data = (await res.json()) as { stats: StorageStats };
          setStats(data.stats);
        } else {
          const data = (await res.json()) as { error?: string };
          setError(data.error || '获取统计信息失败');
        }
      } catch {
        setError('网络错误');
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [storage.id]);

  const sortedTypes = stats
    ? Object.entries(stats.typeDistribution).sort(
        (a, b) => b[1].size - a[1].size,
      )
    : [];
  const chartItems = stats
    ? (() => {
        const topTypes = sortedTypes.slice(0, 10);
        const items = topTypes.map(([ext, data], index) => ({
          ext,
          count: data.count,
          size: data.size,
          percentage:
            stats.totalSize > 0 ? (data.size / stats.totalSize) * 100 : 0,
          color: chartColors[index % chartColors.length],
        }));
        const shownSize = topTypes.reduce(
          (sum, [, data]) => sum + data.size,
          0,
        );
        const shownCount = topTypes.reduce(
          (sum, [, data]) => sum + data.count,
          0,
        );
        const restSize = stats.totalSize - shownSize;
        const restCount = stats.fileCount - shownCount;
        if (restSize > 0 || restCount > 0) {
          items.push({
            ext: 'other',
            count: Math.max(0, restCount),
            size: Math.max(0, restSize),
            percentage:
              stats.totalSize > 0
                ? (Math.max(0, restSize) / stats.totalSize) * 100
                : 0,
            color: chartColors[items.length % chartColors.length],
          });
        }
        return items;
      })()
    : [];
  const donutGradient = buildConicGradient(
    chartItems.map(({ percentage, color }) => ({ percentage, color })),
  );
  const dominantType = chartItems[0];

  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300">
              <BarChart3 className="h-[18px] w-[18px]" />
            </span>
            存储统计 - {storage.name}
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-zinc-400 dark:text-zinc-500 text-sm">
                正在统计中，请稍候...
              </span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-red-500 text-sm">{error}</span>
            </div>
          ) : stats ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-xs text-zinc-500 font-medium mb-1">
                    总大小
                  </div>
                  <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatBytes(stats.totalSize)}
                  </div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-xs text-zinc-500 font-medium mb-1">
                    文件数量
                  </div>
                  <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {stats.fileCount.toLocaleString()}
                  </div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-xs text-zinc-500 font-medium mb-1">
                    文件夹数量
                  </div>
                  <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {stats.folderCount.toLocaleString()}
                  </div>
                </div>
              </div>

              {sortedTypes.length > 0 && (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3">
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-xs text-zinc-500 font-medium">
                          容量构成
                        </div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                          Top {chartItems.length}
                        </div>
                      </div>
                      <div className="flex items-center justify-center">
                        <div
                          className="relative h-40 w-40 rounded-full shadow-inner"
                          style={{ background: donutGradient }}
                          aria-label="文件类型容量环形图"
                        >
                          <div className="absolute inset-5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 flex flex-col items-center justify-center">
                            <div className="text-[11px] text-zinc-500 font-mono">
                              主类型
                            </div>
                            <div className="text-xl text-zinc-900 dark:text-zinc-100 font-semibold">
                              {dominantType ? `.${dominantType.ext}` : '-'}
                            </div>
                            <div className="text-xs text-zinc-500 font-medium">
                              {dominantType
                                ? `${dominantType.percentage.toFixed(1)}%`
                                : '0%'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                      <div className="text-xs text-zinc-500 font-medium mb-3">
                        类型占比
                      </div>
                      <div className="h-4 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700 flex">
                        {chartItems.map((item) => (
                          <div
                            key={item.ext}
                            title={`.${item.ext} ${item.percentage.toFixed(1)}%`}
                            style={{
                              width: `${Math.max(item.percentage, 1)}%`,
                              backgroundColor: item.color,
                            }}
                          />
                        ))}
                      </div>
                      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {chartItems.slice(0, 6).map((item) => (
                          <div
                            key={item.ext}
                            className="min-w-0 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="h-2.5 w-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: item.color }}
                              />
                              <span className="truncate text-xs text-zinc-700 dark:text-zinc-300 font-mono">
                                .{item.ext}
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500 font-mono">
                              {formatBytes(item.size)} ·{' '}
                              {item.percentage.toFixed(1)}%
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-3">
                      文件类型排行
                    </div>
                    <div className="space-y-2.5">
                      {chartItems.map((item) => (
                        <div
                          key={item.ext}
                          className="grid grid-cols-[minmax(48px,72px)_minmax(0,1fr)_minmax(84px,112px)] items-center gap-2 sm:gap-3 text-xs font-medium"
                        >
                          <div className="truncate text-zinc-700 dark:text-zinc-300">
                            .{item.ext}
                          </div>
                          <div className="h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.max(item.percentage, 1)}%`,
                                backgroundColor: item.color,
                              }}
                            />
                          </div>
                          <div className="text-right text-zinc-500">
                            {formatBytes(item.size)} ·{' '}
                            {item.count.toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {stats.fileCount === 0 && (
                <div className="text-center py-8">
                  <span className="text-zinc-400 dark:text-zinc-500 text-sm">
                    此存储为空
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderStatsModal({
  name,
  stats,
  onClose,
}: {
  name: string;
  stats: StorageStats;
  onClose: () => void;
}) {
  const sortedTypes = Object.entries(stats.typeDistribution).sort(
    (a, b) => b[1].size - a[1].size,
  );
  const chartItems = (() => {
    const topTypes = sortedTypes.slice(0, 10);
    const items = topTypes.map(([ext, data], index) => ({
      ext,
      count: data.count,
      size: data.size,
      percentage: stats.totalSize > 0 ? (data.size / stats.totalSize) * 100 : 0,
      color: chartColors[index % chartColors.length],
    }));
    const shownSize = topTypes.reduce((s, [, d]) => s + d.size, 0);
    const shownCount = topTypes.reduce((s, [, d]) => s + d.count, 0);
    const restSize = stats.totalSize - shownSize;
    const restCount = stats.fileCount - shownCount;
    if (restSize > 0 || restCount > 0) {
      items.push({
        ext: 'other',
        count: Math.max(0, restCount),
        size: Math.max(0, restSize),
        percentage:
          stats.totalSize > 0
            ? (Math.max(0, restSize) / stats.totalSize) * 100
            : 0,
        color: chartColors[items.length % chartColors.length],
      });
    }
    return items;
  })();
  const donutGradient = buildConicGradient(
    chartItems.map(({ percentage, color }) => ({ percentage, color })),
  );
  const dominantType = chartItems[0];

  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300">
              <Calculator className="h-[18px] w-[18px]" />
            </span>
            目录统计 - {name}
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                <div className="text-xs text-zinc-500 font-medium mb-1">
                  总大小
                </div>
                <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                  {formatBytes(stats.totalSize)}
                </div>
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                <div className="text-xs text-zinc-500 font-medium mb-1">
                  文件数量
                </div>
                <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                  {stats.fileCount.toLocaleString()}
                </div>
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                <div className="text-xs text-zinc-500 font-medium mb-1">
                  文件夹数量
                </div>
                <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                  {stats.folderCount.toLocaleString()}
                </div>
              </div>
            </div>
            {sortedTypes.length > 0 ? (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3">
                  <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-xs text-zinc-500 font-medium">
                        容量构成
                      </div>
                      <div className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                        Top {chartItems.length}
                      </div>
                    </div>
                    <div className="flex items-center justify-center">
                      <div
                        className="relative h-40 w-40 rounded-full shadow-inner"
                        style={{ background: donutGradient }}
                        aria-label="文件类型容量环形图"
                      >
                        <div className="absolute inset-5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 flex flex-col items-center justify-center">
                          <div className="text-[11px] text-zinc-500 font-mono">
                            主类型
                          </div>
                          <div className="text-xl text-zinc-900 dark:text-zinc-100 font-semibold">
                            {dominantType ? `.${dominantType.ext}` : '-'}
                          </div>
                          <div className="text-xs text-zinc-500 font-medium">
                            {dominantType
                              ? `${dominantType.percentage.toFixed(1)}%`
                              : '0%'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                    <div className="text-xs text-zinc-500 font-medium mb-3">
                      类型占比
                    </div>
                    <div className="h-4 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700 flex">
                      {chartItems.map((item) => (
                        <div
                          key={item.ext}
                          title={`.${item.ext} ${item.percentage.toFixed(1)}%`}
                          style={{
                            width: `${Math.max(item.percentage, 1)}%`,
                            backgroundColor: item.color,
                          }}
                        />
                      ))}
                    </div>
                    <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {chartItems.slice(0, 6).map((item) => (
                        <div
                          key={item.ext}
                          className="min-w-0 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="h-2.5 w-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: item.color }}
                            />
                            <span className="truncate text-xs text-zinc-700 dark:text-zinc-300 font-mono">
                              .{item.ext}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500 font-mono">
                            {formatBytes(item.size)} ·{' '}
                            {item.percentage.toFixed(1)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-3">
                    文件类型排行
                  </div>
                  <div className="space-y-2.5">
                    {chartItems.map((item) => (
                      <div
                        key={item.ext}
                        className="grid grid-cols-[minmax(48px,72px)_minmax(0,1fr)_minmax(84px,112px)] items-center gap-2 sm:gap-3 text-xs font-medium"
                      >
                        <div className="truncate text-zinc-700 dark:text-zinc-300">
                          .{item.ext}
                        </div>
                        <div className="h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(item.percentage, 1)}%`,
                              backgroundColor: item.color,
                            }}
                          />
                        </div>
                        <div className="text-right text-zinc-500">
                          {formatBytes(item.size)} ·{' '}
                          {item.count.toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-8">
                <span className="text-zinc-400 dark:text-zinc-500 text-sm">
                  此目录为空
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function ScanModal({
  results,
  scanning,
  onNavigate,
  onClose,
}: {
  results: {
    bigFiles: S3Object[];
    duplicates: Array<{ size: number; files: S3Object[] }>;
  } | null;
  scanning: boolean;
  onNavigate: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">
            存储扫描 · 大文件 / 潜在重复
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {scanning ? (
            <div className="flex items-center justify-center gap-2 py-12 text-zinc-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />{' '}
              扫描中…大存储请耐心等候
            </div>
          ) : results ? (
            <>
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                  大文件 Top {results.bigFiles.length}
                </div>
                <div className="space-y-1">
                  {results.bigFiles.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => {
                        onNavigate(f.key);
                        onClose();
                      }}
                      className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="text-zinc-400 shrink-0">
                        {(() => {
                          const Ic = fileTypeIcon(getFileType(f.name));
                          return <Ic className="h-4 w-4" />;
                        })()}
                      </span>
                      <span className="truncate flex-1 text-sm text-zinc-700 dark:text-zinc-200">
                        {f.name}
                      </span>
                      <span className="text-xs text-zinc-400 tabular-nums shrink-0">
                        {formatBytes(f.size)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                  潜在重复 · {results.duplicates.length}{' '}
                  组（按完全相同大小聚类，&gt;1MB）
                </div>
                {results.duplicates.length === 0 ? (
                  <div className="text-xs text-zinc-400">未发现潜在重复</div>
                ) : (
                  <div className="space-y-2">
                    {results.duplicates.map((g, i) => (
                      <div
                        key={i}
                        className="rounded border border-zinc-200 dark:border-zinc-700 p-2"
                      >
                        <div className="text-xs text-zinc-500 mb-1 font-mono">
                          {formatBytes(g.size)} × {g.files.length} 个
                        </div>
                        {g.files.map((f) => (
                          <button
                            key={f.key}
                            onClick={() => {
                              onNavigate(f.key);
                              onClose();
                            }}
                            className="flex items-center gap-2 w-full text-left px-1 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <span className="truncate flex-1 text-xs text-zinc-700 dark:text-zinc-300">
                              {f.key}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

interface ReleaseItem {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  isPrerelease: boolean;
  author: string;
}

function ChangelogModal({ onClose }: { onClose: () => void }) {
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchReleases = async () => {
      try {
        const res = await fetch('/api/changelog');
        if (res.ok) {
          const data = (await res.json()) as { releases: ReleaseItem[] };
          setReleases(data.releases);
        } else {
          setError('获取更新日志失败');
        }
      } catch {
        setError('网络错误');
      } finally {
        setLoading(false);
      }
    };
    fetchReleases();
  }, []);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const parseBody = (body: string) => {
    // Parse the changelog body and highlight different types
    return body.split('\n').map((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      let colorClass = 'text-zinc-600 dark:text-zinc-400';
      if (
        trimmed.toLowerCase().startsWith('#update') ||
        trimmed.toLowerCase().startsWith('update')
      ) {
        colorClass = 'text-blue-600 dark:text-blue-400';
      } else if (
        trimmed.toLowerCase().startsWith('#fix') ||
        trimmed.toLowerCase().startsWith('fix')
      ) {
        colorClass = 'text-green-600 dark:text-green-400';
      } else if (
        trimmed.toLowerCase().startsWith('#breaking') ||
        trimmed.toLowerCase().startsWith('breaking')
      ) {
        colorClass = 'text-red-600 dark:text-red-400';
      } else if (
        trimmed.toLowerCase().startsWith('#new') ||
        trimmed.toLowerCase().startsWith('new')
      ) {
        colorClass = 'text-purple-600 dark:text-purple-400';
      }

      return (
        <div key={i} className={`${colorClass} text-sm`}>
          {trimmed}
        </div>
      );
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl max-h-[80vh] rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="text-blue-500">📋</span> 更新日志
          </span>
          <button
            onClick={onClose}
            className="icon-btn h-7 w-7"
            aria-label="关闭"
          >
            <X />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-zinc-400 dark:text-zinc-500 text-sm">
                加载中...
              </span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-red-500 text-sm">{error}</span>
            </div>
          ) : releases.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-zinc-400 dark:text-zinc-500 text-sm">
                暂无更新日志
              </span>
            </div>
          ) : (
            <div className="space-y-6">
              {releases.map((release, idx) => (
                <div key={release.version} className="relative">
                  {idx > 0 && (
                    <div className="absolute -top-3 left-0 right-0 border-t border-zinc-200 dark:border-zinc-700" />
                  )}
                  <div className="flex items-center gap-3 mb-2">
                    <span
                      className={`px-2 py-0.5 text-xs font-medium rounded ${
                        idx === 0
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                      }`}
                    >
                      {release.version}
                    </span>
                    {idx === 0 && (
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
                        Latest
                      </span>
                    )}
                    {release.isPrerelease && (
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400">
                        Pre-release
                      </span>
                    )}
                    <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">
                      {formatDate(release.publishedAt)}
                    </span>
                  </div>
                  {release.name && release.name !== release.version && (
                    <h3 className="text-sm text-zinc-800 dark:text-zinc-200 mb-2">
                      {release.name}
                    </h3>
                  )}
                  <div className="space-y-1 pl-2 border-l-2 border-zinc-200 dark:border-zinc-700">
                    {parseBody(release.body)}
                  </div>
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-2 text-xs text-blue-500 hover:text-blue-400 font-mono"
                  >
                    查看详情 →
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

const SortableRow = ({
  obj,
  index,
  isAdmin,
  canDownload,
  selectedKeys,
  cursor,
  toggleSelect,
  toggleFavorite,
  isFavorite,
  handlePreview,
  downloadFile,
  startShare,
  startRename,
  startMove,
  deleteFolder,
  calcFolderSize,
  calcSizeKey,
  navigateTo,
}: {
  obj: S3Object;
  index: number;
  isAdmin: boolean;
  canDownload: boolean;
  selectedKeys: Set<string>;
  cursor: number;
  toggleSelect: (key: string) => void;
  toggleFavorite: (obj: S3Object) => void;
  isFavorite: (key: string) => boolean;
  handlePreview: (obj: S3Object) => void;
  downloadFile: (key: string) => void;
  startShare: (obj: S3Object) => void;
  startRename: (obj: S3Object) => void;
  startMove: (obj: S3Object) => void;
  deleteFolder: (key: string, name: string) => void;
  calcFolderSize: (key: string, name: string) => void;
  calcSizeKey: string | null;
  navigateTo: (path: string) => void;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: obj.key,
    data: { current: { obj } },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <tr
      ref={(node) => {
        setNodeRef(node);
        if (node && rowRefs.current.set(obj.key, node)) {
          return;
        }
      }}
      {...attributes}
      {...listeners}
      style={{
        ...style,
        borderLeft: cursor === index ? '3px solid #3b82f6' : undefined,
      }}
      className={`border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 transition-colors ${
        selectedKeys.has(obj.key)
          ? 'bg-blue-50/70 dark:bg-blue-900/20'
          : ''
      } ${cursor === index ? 'bg-blue-50/50 dark:bg-blue-900/15' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {isAdmin && (
        <td className="py-2 px-3">
          <input
            type="checkbox"
            checked={selectedKeys.has(obj.key)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(obj.key);
            }}
            className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 accent-blue-600"
          />
        </td>
      )}
      <td className="py-2 px-4">
        {obj.isDirectory ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigateTo(obj.key);
            }}
            className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400"
          >
            <Folder className="h-4 w-4 shrink-0 text-blue-500" />
            <span className="truncate">{obj.name}</span>
          </button>
        ) : isPreviewable(obj.name) ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handlePreview(obj);
            }}
            className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400"
          >
            {getFileIcon(obj.name)}
            <span className="truncate">{obj.name}</span>
          </button>
        ) : (
          <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            <span className="text-zinc-400 dark:text-zinc-500">
              {getFileIcon(obj.name)}
            </span>
            <span className="truncate">{obj.name}</span>
          </span>
        )}
      </td>
      <td className="py-2 px-4 text-right text-zinc-500 tabular-nums">
        {obj.isDirectory ? '-' : formatBytes(obj.size)}
      </td>
      <td className="py-2 px-4 text-right text-zinc-500 tabular-nums">
        {formatDate(obj.lastModified)}
      </td>
      <td className="py-1.5 px-3 text-right">
        {obj.isDirectory ? (
          <div className="flex items-center justify-end gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(obj);
              }}
              className={`icon-btn h-7 w-7 ${isFavorite(obj.key) ? 'text-yellow-500' : ''}`}
              title={isFavorite(obj.key) ? '取消收藏' : '收藏'}
              aria-label="收藏"
            >
              <Star />
            </button>
            {canDownload && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  calcFolderSize(obj.key, obj.name);
                }}
                disabled={calcSizeKey === obj.key}
                className="icon-btn h-7 w-7"
                title="统计大小"
                aria-label="统计大小"
              >
                <Calculator />
              </button>
            )}
            {isAdmin && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startShare(obj);
                  }}
                  className="icon-btn h-7 w-7"
                  title="分享"
                  aria-label="分享"
                >
                  <Share2 />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(obj);
                  }}
                  className="icon-btn h-7 w-7"
                  title="重命名"
                  aria-label="重命名"
                >
                  <Pencil />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startMove(obj);
                  }}
                  className="icon-btn h-7 w-7"
                  title="移动"
                  aria-label="移动"
                >
                  <ArrowRightLeft />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFolder(obj.key, obj.name);
                  }}
                  className="icon-btn h-7 w-7 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                  title="删除文件夹"
                  aria-label="删除文件夹"
                >
                  <Trash2 />
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-end gap-0.5">
            {canDownload && isPreviewable(obj.name) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePreview(obj);
                }}
                className="icon-btn h-7 w-7"
                title="预览"
                aria-label="预览"
              >
                <Play />
              </button>
            )}
            {canDownload && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  downloadFile(obj.key);
                }}
                className="icon-btn h-7 w-7"
                title="下载"
                aria-label="下载"
              >
                <Download />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(obj);
              }}
              className={`icon-btn h-7 w-7 ${isFavorite(obj.key) ? 'text-yellow-500' : ''}`}
              title={isFavorite(obj.key) ? '取消收藏' : '收藏'}
              aria-label="收藏"
            >
              <Star />
            </button>
            {isAdmin && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startShare(obj);
                  }}
                  className="icon-btn h-7 w-7"
                  title="分享"
                  aria-label="分享"
                >
                  <Share2 />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(obj);
                  }}
                  className="icon-btn h-7 w-7"
                  title="重命名"
                  aria-label="重命名"
                >
                  <Pencil />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startMove(obj);
                  }}
                  className="icon-btn h-7 w-7"
                  title="移动"
                  aria-label="移动"
                >
                  <ArrowRightLeft />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFile(obj.key);
                  }}
                  className="icon-btn h-7 w-7 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                  title="删除"
                  aria-label="删除"
                >
                  <Trash2 />
                </button>
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  );
};

const SortableGalleryItem = ({
  obj,
  index,
  isAdmin,
  canDownload,
  selectedKeys,
  cursor,
  toggleSelect,
  toggleFavorite,
  isFavorite,
  handlePreview,
  downloadFile,
  startShare,
  startRename,
  startMove,
  deleteFolder,
  calcFolderSize,
  calcSizeKey,
  navigateTo,
  storageId,
}: {
  obj: S3Object;
  index: number;
  isAdmin: boolean;
  canDownload: boolean;
  selectedKeys: Set<string>;
  cursor: number;
  toggleSelect: (key: string) => void;
  toggleFavorite: (obj: S3Object) => void;
  isFavorite: (key: string) => boolean;
  handlePreview: (obj: S3Object) => void;
  downloadFile: (key: string) => void;
  startShare: (obj: S3Object) => void;
  startRename: (obj: S3Object) => void;
  startMove: (obj: S3Object) => void;
  deleteFolder: (key: string, name: string) => void;
  calcFolderSize: (key: string, name: string) => void;
  calcSizeKey: string | null;
  navigateTo: (path: string) => void;
  storageId: string;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: obj.key,
    data: { current: { obj, storageId } },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div
      {...attributes}
      {...listeners}
      ref={(node) => {
        setNodeRef(node);
        if (node && galleryRowRefs.current.set(obj.key, node)) {
          return;
        }
      }}
      style={style}
    >
      <SortableGalleryItemInner
        obj={obj}
        index={index}
        isAdmin={isAdmin}
        canDownload={canDownload}
        selectedKeys={selectedKeys}
        cursor={cursor}
        toggleSelect={toggleSelect}
        toggleFavorite={toggleFavorite}
        isFavorite={isFavorite}
        handlePreview={handlePreview}
        downloadFile={downloadFile}
        startShare={startShare}
        startRename={startRename}
        startMove={startMove}
        deleteFolder={deleteFolder}
        calcFolderSize={calcFolderSize}
        calcSizeKey={calcSizeKey}
        navigateTo={navigateTo}
        storageId={storageId}
      />
    </div>
  );
};

const SortableGalleryItemInner = ({
  obj,
  index,
  isAdmin,
  canDownload,
  selectedKeys,
  cursor,
  toggleSelect,
  toggleFavorite,
  isFavorite,
  handlePreview,
  downloadFile,
  startShare,
  startRename,
  startMove,
  deleteFolder,
  calcFolderSize,
  calcSizeKey,
  navigateTo,
  storageId,
}: {
  obj: S3Object;
  index: number;
  isAdmin: boolean;
  canDownload: boolean;
  selectedKeys: Set<string>;
  cursor: number;
  toggleSelect: (key: string) => void;
  toggleFavorite: (obj: S3Object) => void;
  isFavorite: (key: string) => boolean;
  handlePreview: (obj: S3Object) => void;
  downloadFile: (key: string) => void;
  startShare: (obj: S3Object) => void;
  startRename: (obj: S3Object) => void;
  startMove: (obj: S3Object) => void;
  deleteFolder: (key: string, name: string) => void;
  calcFolderSize: (key: string, name: string) => void;
  calcSizeKey: string | null;
  navigateTo: (path: string) => void;
  storageId: string;
}) => {
  const isImg = !obj.isDirectory && getFileType(obj.name) === 'image';
  const Ic = obj.isDirectory
    ? null
    : fileTypeIcon(getFileType(obj.name));

  const handleQuickAction = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  return (
    <div
      key={obj.key}
      onClick={() =>
        obj.isDirectory
          ? navigateTo(obj.key)
          : isPreviewable(obj.name)
            ? handlePreview(obj)
            : downloadFile(obj.key)
      }
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (obj.isDirectory) {
          navigateTo(obj.key);
        } else if (isPreviewable(obj.name)) {
          handlePreview(obj);
        }
      }}
      className={`group relative cursor-pointer rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-lg transition-all ${selectedKeys.has(obj.key) ? 'bg-blue-50/70 dark:bg-blue-900/20 ring-2 ring-blue-500/50' : ''} ${cursor === index ? 'ring-2 ring-blue-500' : ''}`}
    >
      <div className="aspect-square flex items-center justify-center bg-zinc-50 dark:bg-zinc-800/50 overflow-hidden">
        {isImg ? (
          <img
            src={apiFileUrl(storageId, obj.key)}
            alt={obj.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          />
        ) : obj.isDirectory ? (
          <Folder className="h-8 w-8 text-blue-500 opacity-70 group-hover:opacity-100 transition" />
        ) : Ic ? (
          <Ic className="h-8 w-8 text-zinc-400" />
        ) : null}
      </div>
      <div className="px-2.5 py-1.5 bg-white dark:bg-zinc-900">
        <div className="truncate text-xs text-zinc-700 dark:text-zinc-200 font-medium">
          {obj.name}
        </div>
        <div className="truncate text-[10px] text-zinc-400">
          {obj.isDirectory ? '文件夹' : formatBytes(obj.size)}
        </div>
      </div>
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
        {selectedKeys.has(obj.key) && (
          <div className="h-6 w-6 rounded-full bg-blue-500 flex items-center justify-center">
            <Check className="h-3 w-3 text-white" />
          </div>
        )}
        <button
          onClick={(e) => handleQuickAction(e, () => toggleSelect(obj.key))}
          className="h-6 w-6 rounded-full bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-900/30 transition"
          title="选中"
        >
          <Check className="h-3 w-3 text-blue-600" />
        </button>
        <button
          onClick={(e) => handleQuickAction(e, () => startShare(obj))}
          className="h-6 w-6 rounded-full bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center hover:bg-green-100 dark:hover:bg-green-900/30 transition"
          title="分享"
        >
          <Share2 className="h-3 w-3 text-green-600" />
        </button>
        <button
          onClick={(e) => handleQuickAction(e, () => downloadFile(obj.key))}
          className="h-6 w-6 rounded-full bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-900/30 transition"
          title="下载"
        >
          <Download className="h-3 w-3 text-blue-600" />
        </button>
      </div>
    </div>
  );
};

function FileBrowser({
  storage,
  isAdmin,
  isDark,
  chunkSizeMB,
}: {
  storage: StorageInfo;
  isAdmin: boolean;
  isDark: boolean;
  chunkSizeMB: number;
}) {
  // Permission checks
  const canList = isAdmin || storage.guestList;
  const canDownload = isAdmin || storage.guestDownload;
  const canUpload = isAdmin || storage.guestUpload;
  const toast = useToast();
  const confirm = useConfirm();

  const [path, setPath] = useState('');
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{
    name: string;
    progress: number;
    currentPart?: number;
    totalParts?: number;
    speed?: number;
    loaded?: number;
    total?: number;
    status: 'uploading' | 'paused' | 'error' | 'success';
    errorMessage?: string;
    startTime?: number;
    pausedAt?: number;
    retryCount?: number;
    failedParts?: number[];
    abortController?: AbortController;
    partProgress?: Record<number, number>;
    partSizes?: Record<number, number>;
  } | null>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const [previewFile, setPreviewFile] = useState<S3Object | null>(null);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [showOfflineDownload, setShowOfflineDownload] = useState(false);
  const [offlineUrl, setOfflineUrl] = useState('');
  const [offlineFilename, setOfflineFilename] = useState('');
  const [offlineDownloading, setOfflineDownloading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeOpen, setReadmeOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploadPartsOpen, setUploadPartsOpen] = useState(true);
  const [globalSearch, setGlobalSearch] = useState(false);
  const [globalResults, setGlobalResults] = useState<S3Object[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
  const [favorites, setFavorites] = useState<
    Array<{
      storageId: number;
      key: string;
      name: string;
      isDirectory: boolean;
    }>
  >(() => {
    try {
      return JSON.parse(localStorage.getItem('clist-favorites') || '[]');
    } catch {
      return [];
    }
  });
  const [favOpen, setFavOpen] = useState(false);
  const [calcSizeKey, setCalcSizeKey] = useState<string | null>(null);
  const [folderStats, setFolderStats] = useState<{
    name: string;
    stats: StorageStats;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    obj: S3Object;
  } | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState('');
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cursor, setCursor] = useState<number>(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scanResults, setScanResults] = useState<{
    bigFiles: S3Object[];
    duplicates: Array<{ size: number; files: S3Object[] }>;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<S3Object | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [moveTarget, setMoveTarget] = useState<S3Object | null>(null);
  const [moveDestPath, setMoveDestPath] = useState('');
  const [moving, setMoving] = useState(false);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchMoveDest, setBatchMoveDest] = useState('');
  const [batchMoving, setBatchMoving] = useState(false);
  const [batchCopyOpen, setBatchCopyOpen] = useState(false);
  const [batchCopyDest, setBatchCopyDest] = useState('');
  const [batchCopying, setBatchCopying] = useState(false);
  const [shareTarget, setShareTarget] = useState<S3Object | null>(null);
  const [shareToken, setShareToken] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [shareQrCode, setShareQrCode] = useState('');
  const [customShareToken, setCustomShareToken] = useState('');
  const [shareExpireHours, setShareExpireHours] = useState(0);
  const [sharePassword, setSharePassword] = useState('');
  const [creatingShare, setCreatingShare] = useState(false);
  const [shareId, setShareId] = useState<number | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // dnd-kit sortable state
  const [activeDragItem, setActiveDragItem] = useState<S3Object | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const galleryRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleDragStart = (event: { active: { id: string }; data?: { current?: { obj?: S3Object } } }) => {
    const obj = event.data?.current?.obj;
    if (obj) setActiveDragItem(obj);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId !== overId) {
      setCursor(visibleObjects.findIndex(o => o.key === overId));
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragItem(null);
    setCursor(-1);
    
    if (!over) return;
    
    const activeId = active.id as string;
    const overId = over.id as string;
    
    if (activeId === overId) return;
    
    const activeObj = objects.find((o) => o.key === activeId);
    const overObj = objects.find((o) => o.key === overId);
    
    if (!activeObj || !overObj) return;
    
    const activePath = activeObj.key.split('/').slice(0, -1).join('/');
    const overPath = overObj.key.split('/').slice(0, -1).join('/');
    
    if (activeObj.isDirectory && overObj.isDirectory) {
      if (activePath !== overPath) {
        await moveDirectory(activeObj, overObj);
      }
    } else if (!activeObj.isDirectory) {
      const destPath = overObj.isDirectory ? overObj.key + '/' : overPath + '/';
      await moveFileToFile(activeObj, destPath);
    }
  };

  const moveDirectory = async (source: S3Object, dest: S3Object) => {
    const newPath = dest.key + '/' + source.name;
    const res = await fetch(apiFileUrl(storage.id, source.key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destPath: newPath, action: 'move' }),
    });
    if (res.ok) {
      toast('目录已移动', 'success');
      loadFiles();
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || '移动失败', 'error');
    }
  };

  const moveFileToFile = async (source: S3Object, destPath: string) => {
    await handleMoveFile(source, { key: destPath, name: destPath.split('/').pop() || destPath, isDirectory: false, size: 0, lastModified: new Date().toISOString() });
  };

  const handleMoveFile = async (source: S3Object, dest: S3Object) => {
    if (source.key === dest.key) return;
    setMoving(true);
    try {
      const res = await fetch(apiFileUrl(storage.id, source.key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destPath: dest.isDirectory ? dest.key : dest.key.split('/').slice(0, -1).join('/') + '/' }),
      });
      if (res.ok) {
        toast('已移动文件', 'success');
        loadFiles();
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.error || '移动失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setMoving(false);
    }
  };

  useEffect(() => {
    setPath('');
    setSearchQuery('');
  }, [storage.id]);

  // 目录 README.md 自动展示
  useEffect(() => {
    setReadme(null);
    if (!objects.length) return;
    const f = objects.find(
      (o) => !o.isDirectory && /^readme\.md$/i.test(o.name),
    );
    if (!f) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${apiFileUrl(storage.id, f.key)}?action=download`,
        );
        if (!res.ok) return;
        const text = await res.text();
        marked.setOptions({ gfm: true, breaks: true });
        const html = await marked(text);
        // 净化 HTML，防止恶意 README 内嵌脚本（存储型 XSS）
        if (!cancelled) setReadme(DOMPurify.sanitize(html));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [objects, storage.id]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${apiFileUrl(storage.id, path)}?action=list`);
      if (res.ok) {
        const data = (await res.json()) as { objects?: S3Object[] };
        setObjects(data.objects || []);
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error || '加载失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, [storage.id, path]);

  useEffect(() => {
    loadFiles();
    setSelectedKeys(new Set()); // path 变化后清空选中
    setCursor(-1);
  }, [storage.id, path, loadFiles]);

  const navigateTo = (newPath: string) => {
    setPath(newPath.replace(/^\//, '').replace(/\/$/, ''));
  };

  const goUp = () => {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    setPath(parts.join('/'));
  };

  // 统一下载：先探测 429 限流并给出友好提示，成功则转 blob 保存
  const triggerDownload = async (key: string) => {
    try {
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=download`);
      if (res.status === 429) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast(data?.error || '下载过于频繁，请稍后再试', 'error');
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast(data?.error || '下载失败', 'error');
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = key.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      toast('网络错误', 'error');
    }
  };

  const downloadFile = (key: string) => {
    triggerDownload(key);
  };

  const deleteFile = async (key: string) => {
    const ok = await confirm({
      title: '删除文件',
      message: `确定删除 ${key}?`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(apiFileUrl(storage.id, key), {
        method: 'DELETE',
      });
      if (res.ok) {
        loadFiles();
        toast('已删除', 'success');
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '删除失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    }
  };

  const deleteFolder = async (key: string, name: string) => {
    const ok = await confirm({
      title: '删除文件夹',
      message: `确定删除文件夹 "${name}" 及其所有内容?`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=rmdir`, {
        method: 'DELETE',
      });
      if (res.ok) {
        loadFiles();
        toast(`已删除文件夹 "${name}"`, 'success');
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '删除失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    }
  };

  const startRename = (obj: S3Object) => {
    setRenameTarget(obj);
    setRenameValue(obj.name);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    if (renameValue.includes('/')) {
      toast('名称不能包含 /', 'error');
      return;
    }
    if (renameValue === renameTarget.name) {
      setRenameTarget(null);
      return;
    }

    setRenaming(true);
    try {
      const key = renameTarget.isDirectory
        ? renameTarget.key
        : renameTarget.key;
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: renameValue.trim() }),
      });
      if (res.ok) {
        setRenameTarget(null);
        loadFiles();
        toast(`已重命名为 "${renameValue.trim()}"`, 'success');
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '重命名失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setRenaming(false);
    }
  };

  const loadAllFolders = async () => {
    const folders: string[] = [''];
    const listRecursive = async (prefix: string) => {
      try {
        const res = await fetch(
          `${apiFileUrl(storage.id, prefix)}?action=list`,
        );
        if (res.ok) {
          const data = (await res.json()) as { objects?: S3Object[] };
          for (const obj of data.objects || []) {
            if (obj.isDirectory) {
              folders.push(obj.key);
              await listRecursive(obj.key);
            }
          }
        }
      } catch {
        // Ignore errors
      }
    };
    await listRecursive('');
    setAllFolders(folders);
  };

  const startMove = async (obj: S3Object) => {
    setMoveTarget(obj);
    setMoveDestPath('');
    await loadAllFolders();
  };

  const handleMove = async () => {
    if (!moveTarget) return;

    setMoving(true);
    try {
      const key = moveTarget.isDirectory ? moveTarget.key : moveTarget.key;
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destPath: moveDestPath }),
      });
      if (res.ok) {
        setMoveTarget(null);
        loadFiles();
        toast('移动完成', 'success');
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '移动失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setMoving(false);
    }
  };

  const startShare = (obj: S3Object) => {
    setShareTarget(obj);
    setShareToken('');
    setShareUrl('');
    setShareQrCode('');
    setCustomShareToken('');
    setShareExpireHours(0);
    setSharePassword('');
    setShareId(null);
    setShareExpiresAt(null);
  };

  const handleCreateShare = async () => {
    if (!shareTarget) return;

    setCreatingShare(true);
    try {
      let expiresAt: string | undefined;
      if (shareExpireHours > 0) {
        const expireDate = new Date();
        expireDate.setHours(expireDate.getHours() + shareExpireHours);
        expiresAt = expireDate.toISOString();
      }

      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storageId: storage.id,
          filePath: shareTarget.key,
          isDirectory: shareTarget.isDirectory,
          expiresAt,
          shareToken: customShareToken.trim() || undefined,
          password: sharePassword.trim() || undefined,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          share: { shareToken: string; id?: number; expiresAt?: string | null };
          shareUrl: string;
        };
        setShareToken(data.share.shareToken);
        setShareUrl(data.shareUrl);
        setShareId(data.share.id ?? null);
        setShareExpiresAt(data.share.expiresAt || null);
        try {
          const QRCode = await import('qrcode');
          const dataUrl = await QRCode.toDataURL(data.shareUrl, {
            margin: 1,
            width: 240,
          });
          setShareQrCode(dataUrl);
        } catch {
          setShareQrCode('');
        }
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '创建分享链接失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setCreatingShare(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        toast('已复制到剪贴板', 'success');
      })
      .catch(() => {
        toast('复制失败，请手动复制', 'error');
      });
  };

  // 撤销分享：删除服务端记录，访客立即无法访问
  const handleRevokeShare = async () => {
    if (!shareId) return;
    const ok = await confirm({
      title: '撤销分享',
      message: '确定撤销此分享链接?撤销后访客将无法再访问。',
      confirmText: '撤销',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/shares?id=${shareId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast('分享已撤销', 'success');
        setShareTarget(null);
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '撤销失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    }
  };

  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const obj of visibleObjects) {
          next.delete(obj.key);
        }
      } else {
        for (const obj of visibleObjects) {
          next.add(obj.key);
        }
      }
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.size === 0) return;

    const folders = objects.filter(
      (obj) => obj.isDirectory && selectedKeys.has(obj.key),
    );
    const files = objects.filter(
      (obj) => !obj.isDirectory && selectedKeys.has(obj.key),
    );

    const msg =
      folders.length > 0
        ? `确定删除 ${files.length} 个文件和 ${folders.length} 个文件夹（含其中所有内容）?`
        : `确定删除 ${files.length} 个文件?`;

    const ok = await confirm({
      title: '批量删除',
      message: msg,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;

    setDeleting(true);
    let failed = 0;

    try {
      // Delete folders first (recursive)
      for (const folder of folders || []) {
        try {
          const res = await fetch(
            `${apiFileUrl(storage.id, folder.key)}?action=rmdir`,
            { method: 'DELETE' },
          );
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }

      // Delete files
      for (const file of files || []) {
        try {
          const res = await fetch(apiFileUrl(storage.id, file.key), {
            method: 'DELETE',
          });
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }

      if (failed > 0) {
        toast(`删除完成，${failed} 个项目删除失败`, 'error');
      } else {
        const total = folders.length + files.length;
        if (folders.length > 0) {
          toast(`已删除 ${total} 个项目（${folders.length} 文件夹 + ${files.length} 文件）`, 'success');
        } else {
          toast(`已删除 ${files.length} 个文件`, 'success');
        }
      }

      setSelectedKeys(new Set());
      loadFiles();
    } finally {
      setDeleting(false);
    }
  };

  const startBatchMove = async () => {
    if (selectedKeys.size === 0) return;
    setBatchMoveDest('');
    await loadAllFolders();
    setBatchMoveOpen(true);
  };

  const startBatchCopy = async () => {
    if (selectedKeys.size === 0) return;
    setBatchCopyDest('');
    await loadAllFolders();
    setBatchCopyOpen(true);
  };

  const handleBatchCopy = async () => {
    if (selectedKeys.size === 0) return;
    setBatchCopying(true);
    let failed = 0;
    try {
      for (const key of selectedKeys) {
        try {
          const res = await fetch(
            `${apiFileUrl(storage.id, key)}?action=copy`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ destPath: batchCopyDest }),
            },
          );
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }
      if (failed > 0) toast(`复制完成，${failed} 个项目失败`, 'error');
      else {
        const count = selectedKeys.size;
        toast(`已复制 ${count} 个项目到 ${batchCopyDest}`, 'success');
      }
      setBatchCopyOpen(false);
      setSelectedKeys(new Set());
      loadFiles();
    } finally {
      setBatchCopying(false);
    }
  };

  const handleBatchMove = async () => {
    if (selectedKeys.size === 0) return;
    setBatchMoving(true);
    let failed = 0;
    try {
      for (const key of selectedKeys) {
        try {
          const res = await fetch(
            `${apiFileUrl(storage.id, key)}?action=move`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ destPath: batchMoveDest }),
            },
          );
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }
      if (failed > 0) toast(`移动完成，${failed} 个项目失败`, 'error');
      else {
        const count = selectedKeys.size;
        toast(`已移动 ${count} 个项目到 ${batchMoveDest}`, 'success');
      }
      setBatchMoveOpen(false);
      setSelectedKeys(new Set());
      loadFiles();
    } finally {
      setBatchMoving(false);
    }
  };

  // 递归收集文件夹内所有文件
  const collectFolderFiles = async (
    folderKey: string,
    prefix: string,
    out: { key: string; name: string }[],
  ) => {
    const res = await fetch(`${apiFileUrl(storage.id, folderKey)}?action=list`);
    if (!res.ok) return;
    const data = (await res.json()) as { objects?: S3Object[] };
    for (const obj of data.objects || []) {
      if (obj.isDirectory) {
        await collectFolderFiles(obj.key, `${prefix}${obj.name}/`, out);
      } else {
        out.push({ key: obj.key, name: `${prefix}${obj.name}` });
      }
    }
  };

  const handleBatchDownload = async () => {
    const files = objects.filter(
      (obj) => !obj.isDirectory && selectedKeys.has(obj.key),
    );
    const folders = objects.filter(
      (obj) => obj.isDirectory && selectedKeys.has(obj.key),
    );
    if (files.length === 0 && folders.length === 0) {
      toast('未选中可下载的文件', 'info');
      return;
    }

    // 选中了文件夹：递归收集后打包 zip
    if (folders.length > 0) {
      const collected: { key: string; name: string }[] = [];
      for (const f of files || []) collected.push({ key: f.key, name: f.name });
      for (const folder of folders || []) {
        await collectFolderFiles(folder.key, folder.name + '/', collected);
      }
      if (collected.length === 0) {
        toast('所选文件夹均为空', 'info');
        return;
      }
      toast(`正在打包 ${collected.length} 个文件为 zip…`, 'info');
      try {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        for (const item of collected) {
          try {
            const res = await fetch(
              `${apiFileUrl(storage.id, item.key)}?action=download`,
            );
            if (res.status === 429) {
              toast('下载过于频繁，部分文件被跳过', 'error');
              break;
            }
            if (!res.ok) continue;
            zip.file(item.name, await res.blob());
          } catch {
            /* 跳过下载失败的文件 */
          }
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${folders.length === 1 ? folders[0].name : 'batch'}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast(`打包完成，已下载 ${collected.length} 个文件`, 'success');
      } catch {
        toast('打包失败', 'error');
      }
      return;
    }

    // 纯文件直下，间隔触发避免浏览器拦截多窗口
    let delay = 0;
    for (const f of files || []) {
      const key = f.key;
      setTimeout(() => triggerDownload(key), delay);
      delay += 400;
    }
    if (files.length > 0) {
      toast(`正在下载 ${files.length} 个文件…`, 'info');
    }
  };

  const isFavorite = (key: string) =>
    favorites.some((f) => f.storageId === storage.id && f.key === key);

  const toggleFavorite = (obj: S3Object) => {
    setFavorites((prev) => {
      const exists = prev.some(
        (f) => f.storageId === storage.id && f.key === obj.key,
      );
      const next = exists
        ? prev.filter((f) => !(f.storageId === storage.id && f.key === obj.key))
        : [
            ...prev,
            {
              storageId: storage.id,
              key: obj.key,
              name: obj.name,
              isDirectory: obj.isDirectory,
            },
          ];
      try {
        localStorage.setItem('clist-favorites', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // 递归统计文件夹大小
  const calcFolderSize = async (key: string, name: string) => {
    setCalcSizeKey(key);
    let total = 0,
      count = 0,
      dirs = 0;
    const typeDist: Record<string, { count: number; size: number }> = {};
    const queue = [key];
    const visited = new Set<string>();
    try {
      while (queue.length > 0 && dirs < 2000) {
        const prefix = queue.shift()!;
        if (visited.has(prefix)) continue;
        visited.add(prefix);
        dirs++;
        const res = await fetch(
          `${apiFileUrl(storage.id, prefix)}?action=list`,
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { objects?: S3Object[] };
        for (const obj of data.objects || []) {
          if (obj.isDirectory) queue.push(obj.key);
          else {
            total += obj.size;
            count++;
            const dot = obj.name.lastIndexOf('.');
            const ext =
              dot > 0
                ? obj.name
                    .slice(dot + 1)
                    .toLowerCase()
                    .slice(0, 12)
                : 'none';
            if (!typeDist[ext]) typeDist[ext] = { count: 0, size: 0 };
            typeDist[ext].count++;
            typeDist[ext].size += obj.size;
          }
        }
      }
      setFolderStats({
        name,
        stats: {
          totalSize: total,
          fileCount: count,
          folderCount: dirs,
          typeDistribution: typeDist,
        },
      });
    } catch {
      toast('统计失败', 'error');
    } finally {
      setCalcSizeKey(null);
    }
  };

  // 存储扫描：递归收集所有文件，找大文件 Top + 按大小聚类的潜在重复
  const scanStorage = async () => {
    setScanning(true);
    setScanResults(null);
    const all: S3Object[] = [];
    const queue = [''];
    const visited = new Set<string>();
    let dirs = 0;
    try {
      while (queue.length > 0 && dirs < 2000) {
        const prefix = queue.shift()!;
        if (visited.has(prefix)) continue;
        visited.add(prefix);
        dirs++;
        const res = await fetch(
          `${apiFileUrl(storage.id, prefix)}?action=list`,
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { objects?: S3Object[] };
        for (const obj of data.objects || []) {
          if (obj.isDirectory) queue.push(obj.key);
          else all.push(obj);
        }
      }
      const bigFiles = [...all].sort((a, b) => b.size - a.size).slice(0, 20);
      const bySize = new Map<number, S3Object[]>();
      for (const f of all) {
        if (f.size < 1024 * 1024) continue;
        const arr = bySize.get(f.size);
        if (arr) arr.push(f);
        else bySize.set(f.size, [f]);
      }
      const duplicates = Array.from(bySize.values())
        .filter((g) => g.length > 1)
        .map((g) => ({ size: g[0].size, files: g }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 20);
      setScanResults({ bigFiles, duplicates });
    } catch {
      toast('扫描失败', 'error');
    } finally {
      setScanning(false);
    }
  };

  const navigateToParent = (key: string) => {
    navigateTo(key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '');
  };

  // 全局搜索：从根 BFS 递归列目录，匹配文件名（限流防大存储卡死）
  const searchGlobal = async (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setGlobalResults([]);
      return;
    }
    setGlobalLoading(true);
    const results: S3Object[] = [];
    const visited = new Set<string>();
    const queue: string[] = [''];
    const MAX_RESULTS = 200;
    const MAX_DIRS = 400;
    let dirs = 0;
    try {
      while (
        queue.length > 0 &&
        results.length < MAX_RESULTS &&
        dirs < MAX_DIRS
      ) {
        const prefix = queue.shift()!;
        if (visited.has(prefix)) continue;
        visited.add(prefix);
        dirs++;
        try {
          const res = await fetch(
            `${apiFileUrl(storage.id, prefix)}?action=list`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as { objects?: S3Object[] };
          for (const obj of data.objects || []) {
            if (results.length >= MAX_RESULTS) break;
            if (obj.name.toLowerCase().includes(q)) results.push(obj);
            if (obj.isDirectory) queue.push(obj.key);
          }
        } catch {
          /* skip unreadable dir */
        }
      }
      setGlobalResults(results);
    } finally {
      setGlobalLoading(false);
    }
  };

  useEffect(() => {
    if (!globalSearch) {
      setGlobalResults([]);
      setGlobalLoading(false);
      return;
    }
    const q = searchQuery.trim();
    if (q.length < 1) {
      setGlobalResults([]);
      return;
    }
    const t = setTimeout(() => searchGlobal(q), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalSearch, searchQuery, storage.id]);

  const uploadFiles = async (fileList: File[]) => {
    if (fileList.length === 0) return;
    const CHUNK_SIZE = chunkSizeMB * 1024 * 1024;
    const sType = storage.type ?? '';
    const maxBytes = GIT_TYPES.has(sType)
      ? getGitMaxFileBytes(sType)
      : 50 * 1024 * 1024 * 1024;
    const maxLabel = GIT_TYPES.has(sType) ? getGitMaxFileLabel(sType) : '50GB';
    for (const file of fileList) {
      try {
        if (file.size > maxBytes) {
          toast(`文件 "${file.name}" 太大（> ${maxLabel}）`, 'error');
          continue;
        }
        const uploadPath = path ? `${path}/${file.name}` : file.name;
        const canMultipart =
          storage.type === 's3' && supportsMultipart(storage.type);
        if (file.size >= CHUNK_SIZE && canMultipart) {
          await uploadMultipart(file, uploadPath, CHUNK_SIZE);
        } else {
          await uploadSingle(file, uploadPath);
        }
      } catch (err) {
        toast(
          `上传 ${file.name} 失败: ${err instanceof Error ? err.message : '未知错误'}`,
          'error',
        );
      }
    }
    setUploadProgress(null);
    loadFiles();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
    e.target.value = '';
  };

  // Ctrl+V 粘贴图片/文件直接上传到当前目录
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!canUpload) return;
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        uploadFiles(Array.from(files));
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUpload, path, storage.id, storage.type, chunkSizeMB]);

  // ⌘K / Ctrl+K 命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
        setCmdQuery('');
        setCmdIndex(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const uploadSingle = async (file: File, uploadPath: string) => {
    setUploadProgress({
      name: file.name,
      progress: 0,
      speed: 0,
      loaded: 0,
      total: file.size,
      status: 'uploading',
    });
    let lastLoaded = 0;
    let lastTs = Date.now();
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          const now = Date.now();
          const elapsed = (now - lastTs) / 1000;
          const speed =
            elapsed > 0
              ? Math.max(0, (event.loaded - lastLoaded) / elapsed)
              : 0;
          lastLoaded = event.loaded;
          lastTs = now;
          setUploadProgress((prev) => ({
            name: file.name,
            progress: percent,
            speed,
            loaded: event.loaded,
            total: event.total,
            status: prev?.status || 'uploading',
            pausedAt: prev?.pausedAt,
          }));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            reject(new Error(data.error || '上传失败'));
          } catch {
            reject(new Error('上传失败'));
          }
        }
      };

      xhr.onerror = () => reject(new Error('网络错误'));

      xhr.open('PUT', apiFileUrl(storage.id, uploadPath));
      xhr.setRequestHeader(
        'Content-Type',
        file.type || 'application/octet-stream',
      );
      xhr.send(file);
    });
  };

  const uploadMultipart = async (
    file: File,
    uploadPath: string,
    chunkSize: number,
  ) => {
    const totalParts = Math.ceil(file.size / chunkSize);
    const contentType = file.type || 'application/octet-stream';
    const CONCURRENT_UPLOADS = 5;

    // Check for existing upload in localStorage (resume support)
    const storageKey = `multipart_${storage.id}_${uploadPath}_${file.size}`;
    const savedState = localStorage.getItem(storageKey);
    let uploadId: string;
    let completedParts: { partNumber: number; etag: string }[] = [];
    let startPart = 0;
    let useDirectUpload = true; // Try direct S3 upload first

    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        if (parsed.uploadId && parsed.parts && parsed.fileName === file.name) {
          const shouldResume = await confirm({
            title: '继续上传',
            message: `检测到未完成的上传 "${file.name}"，是否继续？\n已完成 ${parsed.parts.length}/${totalParts} 分片`,
            confirmText: '继续',
            cancelText: '放弃',
          });
          if (shouldResume) {
            uploadId = parsed.uploadId;
            completedParts = parsed.parts;
            startPart = completedParts.length;
            useDirectUpload = parsed.useDirectUpload ?? true;
          } else {
            try {
              await fetch(
                `${apiFileUrl(storage.id, uploadPath)}?action=multipart-abort`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ uploadId: parsed.uploadId }),
                },
              );
            } catch {
              /* ignore */
            }
            localStorage.removeItem(storageKey);
          }
        }
      } catch {
        /* ignore invalid state */
      }
    }

    // Initialize new upload if needed
    if (!uploadId!) {
      setUploadProgress({
        name: file.name,
        progress: 0,
        currentPart: 0,
        totalParts,
        speed: 0,
        loaded: 0,
        total: file.size,
        status: 'uploading',
      });

      const initRes = await fetch(
        `${apiFileUrl(storage.id, uploadPath)}?action=multipart-init`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType, size: file.size, chunkSize }),
        },
      );

      if (!initRes.ok) {
        const data = (await initRes.json()) as { error?: string };
        throw new Error(data.error || '初始化分片上传失败');
      }

      const initData = (await initRes.json()) as { uploadId: string };
      uploadId = initData.uploadId;

      localStorage.setItem(
        storageKey,
        JSON.stringify({
          uploadId,
          fileName: file.name,
          parts: [],
          useDirectUpload: true,
        }),
      );
    }

    // Speed calculation
    let totalBytesUploaded = startPart * chunkSize;
    const startTime = Date.now();
    const partProgress: Record<number, number> = {};
    const partSizes: Record<number, number> = {};

    const updateProgress = (prevStatus?: UploadProgress['status']) => {
      const currentBytes =
        totalBytesUploaded +
        Object.values(partProgress).reduce((a, b) => a + b, 0);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? currentBytes / elapsed : 0;
      const progress = Math.round((currentBytes / file.size) * 100);

      setUploadProgress((prev) => ({
        name: file.name,
        progress: Math.min(progress, 100),
        currentPart: completedParts.length,
        totalParts,
        speed,
        loaded: currentBytes,
        total: file.size,
        status: prevStatus || prev?.status || 'uploading',
        pausedAt:
          prev?.pausedAt ||
          (prevStatus === 'paused' ? Date.now() : prev?.pausedAt),
        retryCount: prev?.retryCount,
        failedParts: prev?.failedParts,
        partProgress: { ...partProgress },
        partSizes: { ...partSizes },
      }));
    };

    updateProgress();

    try {
      const remainingParts = Array.from(
        { length: totalParts - startPart },
        (_, i) => startPart + i + 1,
      );

      // Get signed URLs for direct upload
      let signedUrls: Record<number, string> = {};
      if (useDirectUpload) {
        try {
          const urlsRes = await fetch(
            `${apiFileUrl(storage.id, uploadPath)}?action=multipart-urls`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uploadId, partNumbers: remainingParts }),
            },
          );
          if (urlsRes.ok) {
            const data = (await urlsRes.json()) as {
              urls: Record<number, string>;
            };
            signedUrls = data.urls;
          }
        } catch {
          /* will fallback to proxy */
        }
      }

      const uploadQueue = remainingParts.map((partNumber) => ({
        partNumber,
        start: (partNumber - 1) * chunkSize,
        end: Math.min(partNumber * chunkSize, file.size),
        size:
          Math.min(partNumber * chunkSize, file.size) -
          (partNumber - 1) * chunkSize,
      }));

      // Upload part - tries direct S3 first, falls back to Workers proxy
      const uploadPart = async (item: {
        partNumber: number;
        start: number;
        end: number;
        size: number;
      }): Promise<{ partNumber: number; etag: string }> => {
        const chunk = file.slice(item.start, item.end);
        partSizes[item.partNumber] = item.size;

        // Try direct S3 upload first
        if (useDirectUpload && signedUrls[item.partNumber]) {
          try {
            const result = await uploadPartDirect(
              chunk,
              signedUrls[item.partNumber],
              item.partNumber,
            );
            return result;
          } catch (e) {
            // CORS or network error - switch to proxy mode
            console.log('Direct upload failed, switching to proxy mode');
            useDirectUpload = false;
            // Update saved state
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                uploadId,
                fileName: file.name,
                parts: completedParts,
                useDirectUpload: false,
              }),
            );
          }
        }

        // Fallback: upload through Workers proxy
        return uploadPartProxy(chunk, uploadPath, uploadId, item.partNumber);
      };

      const uploadPartDirect = (
        chunk: Blob,
        url: string,
        partNumber: number,
      ): Promise<{ partNumber: number; etag: string }> => {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              partProgress[partNumber] = event.loaded;
              updateProgress();
            }
          };

          xhr.onload = () => {
            delete partProgress[partNumber];
            if (xhr.status >= 200 && xhr.status < 300) {
              const etag =
                xhr.getResponseHeader('ETag')?.replace(/"/g, '') || '';
              totalBytesUploaded += chunk.size;
              resolve({ partNumber, etag });
            } else {
              reject(new Error(`Direct upload failed: ${xhr.status}`));
            }
          };

          xhr.onerror = () => {
            delete partProgress[partNumber];
            reject(new Error('Direct upload network error'));
          };

          xhr.open('PUT', url);
          xhr.send(chunk);
        });
      };

      const uploadPartProxy = (
        chunk: Blob,
        path: string,
        upId: string,
        partNumber: number,
      ): Promise<{ partNumber: number; etag: string }> => {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              partProgress[partNumber] = event.loaded;
              updateProgress();
            }
          };

          xhr.onload = () => {
            delete partProgress[partNumber];
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const data = JSON.parse(xhr.responseText);
                totalBytesUploaded += chunk.size;
                resolve({ partNumber, etag: data.etag });
              } catch {
                reject(new Error(`解析响应失败: 分片 ${partNumber}`));
              }
            } else {
              try {
                const data = JSON.parse(xhr.responseText);
                reject(new Error(data.error || `分片 ${partNumber} 失败`));
              } catch {
                reject(new Error(`分片 ${partNumber} 失败: ${xhr.status}`));
              }
            }
          };

          xhr.onerror = () => {
            delete partProgress[partNumber];
            reject(new Error(`网络错误: 分片 ${partNumber}`));
          };

          const url = `${apiFileUrl(storage.id, path)}?action=multipart-upload&uploadId=${encodeURIComponent(upId)}&partNumber=${partNumber}`;
          xhr.open('PUT', url);
          xhr.send(chunk);
        });
      };

      // Process queue with concurrency limit
      let index = 0;

      const runNext = async (): Promise<void> => {
        while (index < uploadQueue.length) {
          const currentIndex = index++;
          const item = uploadQueue[currentIndex];
          const result = await uploadPart(item);
          completedParts.push(result);

          localStorage.setItem(
            storageKey,
            JSON.stringify({
              uploadId,
              fileName: file.name,
              parts: completedParts,
              useDirectUpload,
            }),
          );

          updateProgress();
        }
      };

      // Start concurrent uploads (reduce concurrency for proxy mode)
      const concurrency = useDirectUpload ? CONCURRENT_UPLOADS : 3;
      const workers = Array(Math.min(concurrency, uploadQueue.length))
        .fill(null)
        .map(() => runNext());

      await Promise.all(workers);

      // Complete multipart upload
      const completeRes = await fetch(
        `${apiFileUrl(storage.id, uploadPath)}?action=multipart-complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId, parts: completedParts }),
        },
      );

      if (!completeRes.ok) {
        const data = (await completeRes.json()) as { error?: string };
        throw new Error(data.error || '完成分片上传失败');
      }

      localStorage.removeItem(storageKey);
    } catch (err) {
      throw err;
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    setCreatingFolder(true);
    try {
      const folderPath = path
        ? `${path}/${newFolderName.trim()}`
        : newFolderName.trim();
      const res = await fetch(
        `${apiFileUrl(storage.id, folderPath)}?action=mkdir`,
        {
          method: 'POST',
        },
      );

      if (res.ok) {
        setNewFolderName('');
        setShowNewFolderInput(false);
        loadFiles();
        toast(`已创建文件夹 "${newFolderName.trim()}"`, 'success');
      } else {
        const data = (await res.json()) as { error?: string };
        toast(data.error || '创建文件夹失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleOfflineDownload = async () => {
    if (!offlineUrl.trim()) return;

    setOfflineDownloading(true);
    try {
      const res = await fetch(`${apiFileUrl(storage.id, path)}?action=fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: offlineUrl.trim(),
          filename: offlineFilename.trim() || undefined,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        filename?: string;
        size?: number;
        error?: string;
      };

      if (res.ok && data.success) {
        const sizeStr = data.size ? ` (${formatBytes(data.size)})` : '';
        toast(`下载成功: ${data.filename}${sizeStr}`, 'success');
        setOfflineUrl('');
        setOfflineFilename('');
        setShowOfflineDownload(false);
        loadFiles();
      } else {
        toast(data.error || '下载失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setOfflineDownloading(false);
    }
  };

  const breadcrumbs = path ? path.split('/').filter(Boolean) : [];

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const globalMode = globalSearch && searchQuery.trim().length > 0;

  // 命令面板：命令 + 当前目录文件 + 收藏，模糊匹配
  const allCommands: Array<{
    id: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    action: () => void;
    admin?: boolean;
    disabled?: boolean;
  }> = [
    {
      id: 'refresh',
      label: '刷新文件列表',
      icon: RefreshCw,
      action: loadFiles,
    },
    {
      id: 'newfolder',
      label: '新建文件夹',
      icon: FolderPlus,
      action: () => setShowNewFolderInput(true),
      admin: true,
    },
    {
      id: 'gallery',
      label: viewMode === 'list' ? '切换到网格视图' : '切换到列表视图',
      icon: LayoutGrid,
      action: () => setViewMode((v) => (v === 'list' ? 'gallery' : 'list')),
    },
    {
      id: 'root',
      label: '回到根目录',
      icon: Folder,
      action: () => navigateTo(''),
    },
    {
      id: 'up',
      label: '返回上级目录',
      icon: ArrowLeft,
      action: goUp,
      disabled: !path,
    },
    {
      id: 'globalsearch',
      label: '全局搜索文件',
      icon: Globe,
      action: () => setGlobalSearch(true),
    },
    {
      id: 'favorites',
      label: '打开收藏夹',
      icon: Star,
      action: () => setFavOpen(true),
    },
    {
      id: 'scan',
      label: '扫描大文件 / 查找重复',
      icon: Calculator,
      action: scanStorage,
    },
  ];
  const cmdQ = cmdQuery.trim().toLowerCase();
  const cmdCommands = allCommands.filter(
    (c) =>
      (!c.admin || isAdmin) && (!cmdQ || c.label.toLowerCase().includes(cmdQ)),
  );
  const cmdFiles = cmdQ
    ? objects.filter((o) => o.name.toLowerCase().includes(cmdQ)).slice(0, 6)
    : [];
  const cmdFavs = cmdQ
    ? favorites
        .filter(
          (f) =>
            f.storageId === storage.id && f.name.toLowerCase().includes(cmdQ),
        )
        .slice(0, 4)
    : [];
  type CmdItem =
    | {
        kind: 'cmd';
        id: string;
        label: string;
        icon: React.ComponentType<{ className?: string }>;
        action: () => void;
        disabled?: boolean;
      }
    | { kind: 'file'; obj: S3Object }
    | { kind: 'fav'; fav: { key: string; name: string; isDirectory: boolean } };
  const flatCmdItems: CmdItem[] = [
    ...cmdCommands.map((c) => ({
      kind: 'cmd' as const,
      id: c.id,
      label: c.label,
      icon: c.icon,
      action: c.action,
      disabled: c.disabled,
    })),
    ...cmdFiles.map((o) => ({ kind: 'file' as const, obj: o })),
    ...cmdFavs.map((f) => ({
      kind: 'fav' as const,
      fav: { key: f.key, name: f.name, isDirectory: f.isDirectory },
    })),
  ];
  const execCmdItem = (item: CmdItem) => {
    setCmdOpen(false);
    setCmdQuery('');
    if (item.kind === 'cmd') {
      if (!item.disabled) item.action();
    } else if (item.kind === 'file') {
      const o = item.obj;
      if (o.isDirectory) navigateTo(o.key);
      else if (isPreviewable(o.name)) handlePreview(o);
      else downloadFile(o.key);
    } else {
      const f = item.fav;
      navigateTo(
        f.isDirectory
          ? f.key
          : f.key.includes('/')
            ? f.key.slice(0, f.key.lastIndexOf('/'))
            : '',
      );
    }
  };
  // 列表排序：名称/大小/修改时间，点击表头切换键与升降序
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'modified'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const handleSort = (key: 'name' | 'size' | 'modified') => {
    if (sortKey === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortOrder(key === 'name' ? 'asc' : 'desc');
    }
  };

  // 目录始终排在文件前，同类别内按所选键排序
  const visibleObjects = useMemo(() => {
    const list = normalizedQuery
      ? objects.filter((obj) =>
          obj.name.toLowerCase().includes(normalizedQuery),
        )
      : objects;
    const dirs = list.filter((o) => o.isDirectory);
    const files = list.filter((o) => !o.isDirectory);
    const compare = (a: S3Object, b: S3Object): number => {
      if (sortKey === 'size') return (a.size || 0) - (b.size || 0);
      if (sortKey === 'modified')
        return (
          new Date(a.lastModified).getTime() -
          new Date(b.lastModified).getTime()
        );
      return a.name.localeCompare(b.name, 'zh-CN', {
        numeric: true,
        sensitivity: 'base',
      });
    };
    const applyOrder = (arr: S3Object[]) => {
      arr.sort(compare);
      return sortOrder === 'desc' ? arr.reverse() : arr;
    };
    return [...applyOrder(dirs), ...applyOrder(files)];
  }, [normalizedQuery, objects, sortKey, sortOrder]);
  const allVisibleSelected =
    visibleObjects.length > 0 &&
    visibleObjects.every((obj) => selectedKeys.has(obj.key));

  const hasSearch = normalizedQuery.length > 0;
  const searchResultCount = visibleObjects.length;

  // 键盘流：j/k 选行 h 上级 g 根目录 r 刷新 / 搜索 Esc 取消选中 Space 选中 Delete 删除 Ctrl+A 全选
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') {
        e.preventDefault();
        setCursor((c) => {
          const n = visibleObjects.length;
          if (n === 0) return -1;
          const next = k === 'j' ? (c >= n - 1 ? 0 : c + 1) : (c <= 0 ? n - 1 : c - 1);
          requestAnimationFrame(() => {
            const obj = visibleObjects[next];
            if (obj) {
              const el = rowRefs.current.get(obj.key) || galleryRowRefs.current.get(obj.key);
              el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          });
          return next;
        });
      } else if (k === 'enter') {
        const obj = visibleObjects[cursor];
        if (obj) {
          e.preventDefault();
          if (obj.isDirectory) navigateTo(obj.key);
          else if (isPreviewable(obj.name)) handlePreview(obj);
          else downloadFile(obj.key);
        }
      } else if (k === ' ') {
        const obj = visibleObjects[cursor];
        if (obj) {
          e.preventDefault();
          toggleSelect(obj.key);
        }
      } else if (k === 'delete' || k === 'backspace') {
        if (selectedKeys.size > 0) {
          e.preventDefault();
          handleBatchDelete();
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (k === 'a') {
          e.preventDefault();
          toggleSelectAll();
        }
      } else if (k === 'h') {
        e.preventDefault();
        goUp();
      } else if (k === 'g') {
        e.preventDefault();
        navigateTo('');
      } else if (k === 'r') {
        e.preventDefault();
        loadFiles();
      } else if (k === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (k === 'n' && isAdmin) {
        e.preventDefault();
        setShowNewFolderInput(true);
      } else if (k === 'escape') {
        if (showHelp) {
          setShowHelp(false);
        } else {
          setCursor(-1);
          setSelectedKeys(new Set());
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleObjects, cursor]);

  // Get previewable files for navigation
  const previewableFiles = visibleObjects.filter(
    (obj) => !obj.isDirectory && isPreviewable(obj.name),
  );
  const currentPreviewIndex = previewFile
    ? previewableFiles.findIndex((f) => f.key === previewFile.key)
    : -1;

  const handlePreview = (obj: S3Object) => {
    if (isPreviewable(obj.name)) {
      setPreviewFile(obj);
    }
  };

  const handlePrevPreview = () => {
    if (currentPreviewIndex > 0) {
      setPreviewFile(previewableFiles[currentPreviewIndex - 1]);
    }
  };

  const handleNextPreview = () => {
    if (currentPreviewIndex < previewableFiles.length - 1) {
      setPreviewFile(previewableFiles[currentPreviewIndex + 1]);
    }
  };

  // Get file icon based on type
  const getFileIcon = (fileName: string, className = 'h-4 w-4 shrink-0') => {
    const Icon = fileTypeIcon(getFileType(fileName));
    return <Icon className={className} />;
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 py-2 px-4 border-b border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/40">
        <div className="flex items-center gap-0.5 text-sm overflow-x-auto min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => setPath('')}
            className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 font-medium text-zinc-600 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400 shrink-0"
          >
            <Folder className="h-4 w-4 text-blue-500" />
            {storage.name}
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center shrink-0">
              <ChevronRight className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
              <button
                onClick={() =>
                  navigateTo(breadcrumbs.slice(0, i + 1).join('/'))
                }
                className="rounded px-1.5 py-1 text-zinc-500 hover:text-blue-600 dark:text-zinc-400 dark:hover:text-blue-400"
              >
                {part}
              </button>
            </span>
          ))}
          {/* Selection info */}
          {selectedKeys.size > 0 && (
            <>
              <span className="ml-2 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 shrink-0">
                已选 {selectedKeys.size} 项
              </span>
              <button
                onClick={() => setSelectedKeys(new Set())}
                className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                title="清除选择"
                aria-label="清除选择"
              >
                <X className="h-3 w-3" />
              </button>
            </>
          )}
          {hasSearch && (
            <span className="ml-2 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400 shrink-0">
              找到 {searchResultCount} 个结果
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative group">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 group-focus-within:text-blue-500 transition-colors" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索…"
              className="w-40 sm:w-48 md:w-56 focus-within:w-60 transition-all duration-200 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 py-1.5 pl-8 pr-7 text-xs text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:text-zinc-300 dark:hover:bg-zinc-700 transition-colors"
                title="清空搜索"
                aria-label="清空搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 text-[10px] text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-0.5 pointer-events-none">
              /
            </kbd>
          </div>
          <button
            onClick={() => {
              setGlobalSearch((g) => !g);
              setGlobalResults([]);
            }}
            className={`icon-btn h-8 w-8 ${globalSearch ? 'text-blue-600 dark:text-blue-400 bg-blue-500/10' : ''}`}
            title={globalSearch ? '全局搜索中（点击切回当前目录）' : '全局搜索'}
            aria-label="全局搜索"
          >
            <Globe />
          </button>
          <button
            onClick={() =>
              setViewMode((v) => (v === 'list' ? 'gallery' : 'list'))
            }
            className={`icon-btn h-8 w-8 ${viewMode === 'gallery' ? 'text-blue-600 dark:text-blue-400 bg-blue-500/10' : ''}`}
            title={viewMode === 'list' ? '网格视图' : '列表视图'}
            aria-label="切换视图"
          >
            {viewMode === 'list' ? <LayoutGrid /> : <List />}
          </button>
          <div className="relative">
            <button
              onClick={() => setFavOpen((o) => !o)}
              className={`icon-btn h-8 w-8 ${favOpen ? 'text-yellow-500 bg-yellow-500/10' : ''}`}
              title="收藏夹"
              aria-label="收藏夹"
            >
              <Star />
            </button>
            {favOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setFavOpen(false)}
                />
                <div className="absolute right-0 top-9 z-50 min-w-[220px] max-h-80 overflow-auto bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg py-1">
                  {favorites.filter((f) => f.storageId === storage.id)
                    .length === 0 ? (
                    <div className="px-3 py-4 text-center">
                      <div className="flex flex-col items-center gap-1.5">
                        <Star className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
                        <p className="text-xs text-zinc-400 dark:text-zinc-500">
                          暂无收藏
                        </p>
                        <p className="text-xs text-zinc-400 dark:text-zinc-600 max-w-[180px]">
                          右键或操作列 ☆ 收藏常用目录/文件
                        </p>
                      </div>
                    </div>
                  ) : (
                    favorites
                      .filter((f) => f.storageId === storage.id)
                      .map((f) => {
                        const parent = f.key.includes('/')
                          ? f.key.slice(0, f.key.lastIndexOf('/'))
                          : '';
                        return (
                          <div
                            key={f.key}
                            className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                          >
                            <button
                              onClick={() => {
                                setFavOpen(false);
                                navigateTo(f.isDirectory ? f.key : parent);
                              }}
                              className="flex items-center gap-2 flex-1 min-w-0 text-left"
                            >
                              {f.isDirectory ? (
                                <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                              ) : (
                                <span className="text-zinc-400 shrink-0">
                                  {(() => {
                                    const Ic = fileTypeIcon(
                                      getFileType(f.name),
                                    );
                                    return <Ic className="h-4 w-4" />;
                                  })()}
                                </span>
                              )}
                              <span className="truncate text-sm text-zinc-700 dark:text-zinc-200">
                                {f.name}
                              </span>
                            </button>
                            <button
                              onClick={() =>
                                toggleFavorite({
                                  key: f.key,
                                  name: f.name,
                                  isDirectory: f.isDirectory,
                                } as S3Object)
                              }
                              className="text-zinc-400 hover:text-red-500 shrink-0"
                              title="移除收藏"
                              aria-label="移除收藏"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })
                  )}
                </div>
              </>
            )}
          </div>
          {/* Batch actions */}
          {isAdmin && selectedKeys.size > 0 && (
            <>
              <button
                onClick={startBatchMove}
                className="btn btn-sm btn-outline"
              >
                <ArrowRightLeft />
                {`移动 (${selectedKeys.size})`}
              </button>
              <button
                onClick={startBatchCopy}
                className="btn btn-sm btn-outline"
              >
                <Copy />
                {`复制到 (${selectedKeys.size})`}
              </button>
              <button
                onClick={handleBatchDownload}
                className="btn btn-sm btn-outline"
              >
                <Download />
                {`下载 (${objects.filter((o) => !o.isDirectory && selectedKeys.has(o.key)).length})`}
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={deleting}
                className="btn btn-sm btn-danger"
              >
                <Trash2 />
                {deleting ? '删除中...' : `删除 (${selectedKeys.size})`}
              </button>
            </>
          )}
          {path && (
            <button
              onClick={goUp}
              className="btn btn-sm btn-ghost"
              title="返回上级目录"
            >
              <ArrowLeft />
              上级
            </button>
          )}
          <button
            onClick={loadFiles}
            className="icon-btn h-8 w-8"
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw />
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="icon-btn h-8 w-8"
            title="快捷键"
            aria-label="快捷键"
          >
            <AlertCircle />
          </button>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-0.5 pointer-events-none ml-1">
            ?
          </kbd>
          {isAdmin && (
            <>
              <button
                onClick={() => setShowNewFolderInput(true)}
                className="btn btn-sm btn-ghost"
                title="新建文件夹"
              >
                <FolderPlus />
                文件夹
              </button>
              <button
                onClick={() => setShowOfflineDownload(true)}
                className="btn btn-sm btn-ghost"
                title="离线下载"
              >
                <Download />
                离线下载
              </button>
            </>
          )}
          {canUpload && (
            <label
              className={`btn btn-sm btn-primary cursor-pointer ${uploadProgress ? 'pointer-events-none opacity-50' : ''}`}
            >
              {uploadProgress ? (
                '上传中…'
              ) : (
                <>
                  <Upload />
                  上传
                </>
              )}
              <input
                type="file"
                multiple
                onChange={handleUpload}
                className="hidden"
                disabled={!!uploadProgress}
              />
            </label>
          )}
        </div>
      </div>

      {/* New Folder Input */}
      {showNewFolderInput && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">新建文件夹:</span>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') {
                  setShowNewFolderInput(false);
                  setNewFolderName('');
                }
              }}
              placeholder="输入文件夹名称"
              className="field flex-1 py-1.5"
              autoFocus
              disabled={creatingFolder}
            />
            <button
              onClick={handleCreateFolder}
              disabled={creatingFolder || !newFolderName.trim()}
              className="btn btn-sm btn-primary"
            >
              {creatingFolder ? '创建中…' : '创建'}
            </button>
            <button
              onClick={() => {
                setShowNewFolderInput(false);
                setNewFolderName('');
              }}
              className="btn btn-sm btn-ghost"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Offline Download Input */}
      {showOfflineDownload && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 shrink-0">链接地址:</span>
              <input
                type="url"
                value={offlineUrl}
                onChange={(e) => setOfflineUrl(e.target.value)}
                placeholder="https://example.com/file.zip"
                className="field flex-1 py-1.5"
                autoFocus
                disabled={offlineDownloading}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 shrink-0">文件名称:</span>
              <input
                type="text"
                value={offlineFilename}
                onChange={(e) => setOfflineFilename(e.target.value)}
                placeholder="可选，留空自动识别"
                className="field flex-1 py-1.5"
                disabled={offlineDownloading}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleOfflineDownload();
                  if (e.key === 'Escape') {
                    setShowOfflineDownload(false);
                    setOfflineUrl('');
                    setOfflineFilename('');
                  }
                }}
              />
              <button
                onClick={handleOfflineDownload}
                disabled={offlineDownloading || !offlineUrl.trim()}
                className="btn btn-sm btn-primary whitespace-nowrap"
              >
                <Download />
                {offlineDownloading ? '下载中…' : '开始下载'}
              </button>
              <button
                onClick={() => {
                  setShowOfflineDownload(false);
                  setOfflineUrl('');
                  setOfflineFilename('');
                }}
                disabled={offlineDownloading}
                className="btn btn-sm btn-ghost"
              >
                取消
              </button>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              提示: 文件将下载到当前目录，大文件可能需要较长时间
            </p>
          </div>
        </div>
      )}

      {/* Upload Progress */}
      {uploadProgress && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-600 dark:text-zinc-300 truncate font-medium">
                  {uploadProgress.status === 'uploading' && '正在上传'}
                  {uploadProgress.status === 'paused' && '已暂停'}
                  {uploadProgress.status === 'error' && '上传失败'}
                  {uploadProgress.status === 'success' && '上传完成'}
                  {uploadProgress.name && (
                    <span className="text-zinc-400 dark:text-zinc-500 ml-1">
                      - {uploadProgress.name}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {uploadProgress.status === 'uploading' && (
                    <span className="text-xs text-zinc-500 w-12 text-right tabular-nums font-mono">
                      {uploadProgress.progress}%
                    </span>
                  )}
                  {uploadProgress.status === 'success' && (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  )}
                  {uploadProgress.status === 'error' && (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  {uploadProgress.status === 'paused' && (
                    <Pause className="h-4 w-4 text-yellow-500" />
                  )}
                </div>
              </div>
              {uploadProgress.status === 'uploading' && (
                <div className="flex items-center gap-3 mt-1">
                  {uploadProgress.totalParts && (
                    <span className="text-xs text-zinc-400 tabular-nums">
                      分片 {uploadProgress.currentPart}/
                      {uploadProgress.totalParts}
                    </span>
                  )}
                  {uploadProgress.speed !== undefined &&
                    uploadProgress.speed > 0 && (
                      <span className="text-xs text-blue-500 tabular-nums font-mono">
                        {formatSpeed(uploadProgress.speed)}
                      </span>
                    )}
                  {uploadProgress.loaded !== undefined &&
                    uploadProgress.total !== undefined &&
                    uploadProgress.speed !== undefined &&
                    uploadProgress.speed > 0 && (
                      <span className="text-xs text-zinc-400 tabular-nums">
                        剩余{' '}
                        {formatTimeLeft(
                          uploadProgress.speed,
                          uploadProgress.total - uploadProgress.loaded,
                        )}
                      </span>
                    )}
                  {uploadProgress.loaded !== undefined &&
                    uploadProgress.total !== undefined && (
                      <span className="text-xs text-zinc-400 tabular-nums">
                        {formatBytes(uploadProgress.loaded)} /{' '}
                        {formatBytes(uploadProgress.total)}
                      </span>
                    )}
                </div>
              )}
              {uploadProgress.status === 'paused' && (
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs text-zinc-400 tabular-nums">
                    {uploadProgress.loaded !== undefined &&
                      uploadProgress.total !== undefined && (
                        <>
                          {formatBytes(uploadProgress.loaded)} /{' '}
                          {formatBytes(uploadProgress.total)}
                        </>
                      )}
                  </span>
                  {uploadProgress.pausedAt && (
                    <span className="text-xs text-zinc-400 tabular-nums">
                      暂停于{' '}
                      {new Date(uploadProgress.pausedAt).toLocaleTimeString(
                        'zh-CN',
                        {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        },
                      )}
                    </span>
                  )}
                </div>
              )}
              {uploadProgress.status === 'error' &&
                uploadProgress.errorMessage && (
                  <div className="text-xs text-red-500 mt-1">
                    {uploadProgress.errorMessage}
                    {uploadProgress.retryCount !== undefined && (
                      <span className="block">
                        重试次数: {uploadProgress.retryCount}
                      </span>
                    )}
                    {uploadProgress.failedParts &&
                      uploadProgress.failedParts.length > 0 && (
                        <span className="block">
                          失败分片: {uploadProgress.failedParts.join(', ')}
                        </span>
                      )}
                  </div>
                )}
            </div>
            {uploadProgress.status === 'uploading' &&
              uploadAbortControllerRef.current && (
                <button
                  onClick={() => {
                    uploadAbortControllerRef.current?.abort();
                    uploadAbortControllerRef.current = null;
                  }}
                  className="shrink-0 p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded transition"
                  title="停止上传"
                >
                  <StopCircle className="h-4 w-4 text-red-500" />
                </button>
              )}
            {uploadProgress.status === 'paused' && (
              <button
                onClick={() => {
                  setUploadProgress({ ...uploadProgress, status: 'uploading' });
                }}
                className="shrink-0 p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded transition"
                title="继续上传"
              >
                <Resume className="h-4 w-4 text-green-500" />
              </button>
            )}
          </div>
          {uploadProgress.status === 'uploading' && (
            <div className="mt-2 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-150 ease-out rounded-full"
                style={{ width: `${uploadProgress.progress}%` }}
              />
            </div>
          )}
          {uploadProgress.status === 'uploading' &&
            uploadProgress.partProgress &&
            uploadProgress.partSizes &&
            uploadProgress.totalParts && (
              <div className="mt-2">
                <button
                  onClick={() => setUploadPartsOpen((o) => !o)}
                  className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition"
                >
                  {uploadPartsOpen ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  <span>分片进度</span>
                  <span className="text-zinc-300 dark:text-zinc-600">
                    (
                    {
                      Array.from(
                        { length: uploadProgress.totalParts },
                        (_, i) => i + 1,
                      ).filter(
                        (p) => !uploadProgress.partProgress?.hasOwnProperty(p),
                      ).length
                    }
                    /{uploadProgress.totalParts} 完成)
                  </span>
                </button>
                {uploadPartsOpen && (
                  <div className="mt-1 space-y-1">
                    {Array.from(
                      { length: uploadProgress.totalParts },
                      (_, i) => i + 1,
                    ).map((partNumber) => {
                      const loaded =
                        uploadProgress.partProgress?.[partNumber] || 0;
                      const size = uploadProgress.partSizes?.[partNumber] || 0;
                      const isCompleted =
                        !uploadProgress.partProgress?.hasOwnProperty(
                          partNumber,
                        );
                      const isFailed =
                        uploadProgress.failedParts?.includes(partNumber);
                      const progress =
                        size > 0 ? Math.round((loaded / size) * 100) : 0;

                      return (
                        <div
                          key={partNumber}
                          className="flex items-center gap-2"
                        >
                          <span
                            className={`text-xs w-12 tabular-nums ${
                              isFailed
                                ? 'text-red-500 font-medium'
                                : 'text-zinc-400'
                            }`}
                          >
                            分片 {partNumber}
                          </span>
                          <div className="flex-1 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-150 ease-out rounded-full ${
                                isFailed
                                  ? 'bg-red-500'
                                  : isCompleted
                                    ? 'bg-green-500'
                                    : 'bg-blue-500'
                              }`}
                              style={{
                                width: `${Math.min(progress, 100)}%`,
                              }}
                            />
                          </div>
                          <span
                            className={`text-xs w-16 text-right tabular-nums ${
                              isFailed ? 'text-red-500' : 'text-zinc-400'
                            }`}
                          >
                            {isFailed
                              ? '失败'
                              : isCompleted
                                ? '完成'
                                : `${progress}% (${formatBytes(loaded)}/${formatBytes(size)})`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          {uploadProgress.status === 'success' && (
            <div className="mt-2 h-1.5 bg-green-500 rounded-full" />
          )}
          {uploadProgress.status === 'error' && (
            <div className="mt-2 h-1.5 bg-red-500 rounded-full" />
          )}
          {uploadProgress.status === 'paused' && (
            <div className="mt-2 h-1.5 bg-yellow-500 rounded-full" />
          )}
        </div>
      )}

      {/* Directory README */}
      {readme && (
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
          <button
            onClick={() => setReadmeOpen((o) => !o)}
            className="flex items-center gap-2 w-full px-4 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/40"
          >
            <FileText className="h-4 w-4 text-blue-500 shrink-0" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              README
            </span>
            <span className="text-xs text-zinc-400 ml-auto">
              {readmeOpen ? '收起' : '展开'}
            </span>
          </button>
          {readmeOpen && (
            <div className="px-4 pb-4 pt-1 max-w-4xl">
              <div
                className="docx-content text-sm"
                dangerouslySetInnerHTML={{ __html: readme }}
              />
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div
        className={`flex-1 overflow-auto relative transition-all duration-200 ${dragOver ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
        onDragOver={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (canUpload && e.dataTransfer.files.length > 0) {
            uploadFiles(Array.from(e.dataTransfer.files));
          }
        }}
      >
        {dragOver && (
          <div className="absolute inset-2 z-20 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none backdrop-blur-sm">
            <div className="text-center p-6">
              <div className="flex justify-center mb-4">
                <Upload className="h-12 w-12 text-blue-500 animate-bounce" />
              </div>
              <span className="text-blue-600 dark:text-blue-300 font-semibold text-xl block">
                松开以上传到当前目录
              </span>
              <span className="text-blue-500 dark:text-blue-400 text-sm mt-2 block">
                支持拖入多个文件或文件夹
              </span>
            </div>
          </div>
        )}
        {globalMode ? (
          <div className="p-4">
            {globalLoading && (
              <div className="flex items-center justify-center gap-2 h-20 text-zinc-500 text-sm">
                <RefreshCw className="h-4 w-4 animate-spin" />
                搜索中…（已找到 {globalResults.length}）
              </div>
            )}
            {!globalLoading && globalResults.length === 0 && (
              <div className="flex items-center justify-center h-20 text-zinc-400 text-sm">
                无匹配结果
              </div>
            )}
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {globalResults.map((obj) => {
                const parent = obj.key.includes('/')
                  ? obj.key.slice(0, obj.key.lastIndexOf('/'))
                  : '';
                return (
                  <button
                    key={obj.key}
                    onClick={() => {
                      setGlobalSearch(false);
                      setSearchQuery('');
                      navigateTo(parent);
                    }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/40"
                  >
                    {obj.isDirectory ? (
                      <Folder className="h-4 w-4 shrink-0 text-blue-500" />
                    ) : (
                      <span className="text-zinc-400">
                        {getFileIcon(obj.name)}
                      </span>
                    )}
                    <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">
                      {obj.name}
                    </span>
                    {parent && (
                      <span className="truncate text-xs text-zinc-400 ml-auto">
                        /{parent}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center gap-3 h-32 text-zinc-500">
            <div className="relative w-10 h-10">
              <div className="absolute inset-0 rounded-full border-2 border-blue-200 dark:border-blue-900" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-500 animate-spin" />
              <div className="absolute inset-1 rounded-full border-2 border-transparent border-b-blue-400 animate-spin animate-reverse" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">正在加载文件...</p>
              <div className="mt-2 flex justify-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-4 p-4 h-32 text-zinc-400 dark:text-zinc-600">
            <AlertCircle className="h-6 w-6" />
            <div className="text-center">
              <p className="text-sm font-medium mb-2">加载失败</p>
              <button
                onClick={() => setError('')}
                className="text-xs text-blue-600 dark:text-blue-400 underline hover:no-underline"
              >
                重试
              </button>
            </div>
          </div>
        ) : objects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-6 p-6 h-64 text-zinc-400 dark:text-zinc-600">
            <div className="p-4 bg-zinc-100 dark:bg-zinc-800 rounded-full">
              <Folder className="h-8 w-8 text-blue-500" />
            </div>
            <div className="text-center space-y-2">
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">空目录</p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 max-w-xs mx-auto">
                这里暂无文件<br/>
                可以在此上传文件或创建目录
              </p>
            </div>
            <div className="flex items-center gap-2 justify-center">
              {canUpload && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/30 transition"
                >
                  <Upload className="h-3 w-3" />
                  <span>上传文件</span>
                </button>
              )}
              <button
                onClick={() => setShowNewFolderInput(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/30 transition"
              >
                <FolderPlus className="h-3 w-3" />
                <span>新建文件夹</span>
              </button>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-500">
              快捷键: <kbd className="mx-0.5 px-1 py-0.5 bg-zinc-200 dark:bg-zinc-700 rounded">n</kbd> 新建文件夹 | <kbd className="mx-0.5 px-1 py-0.5 bg-zinc-200 dark:bg-zinc-700 rounded">/</kbd> 搜索
            </div>
          </div>
        ) : viewMode === 'gallery' ? (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
          <div className="p-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <SortableContext items={visibleObjects.map((o) => o.key)} strategy={verticalListSortingStrategy}>
              {visibleObjects.map((obj, i) => (
                <SortableGalleryItem
                  key={obj.key}
                  obj={obj}
                  index={i}
                  isAdmin={isAdmin}
                  canDownload={canDownload}
                  selectedKeys={selectedKeys}
                  cursor={cursor}
                  toggleSelect={toggleSelect}
                  toggleFavorite={toggleFavorite}
                  isFavorite={isFavorite}
                  handlePreview={handlePreview}
                  downloadFile={downloadFile}
                  startShare={startShare}
                  startRename={startRename}
                  startMove={startMove}
                  deleteFolder={deleteFolder}
                  calcFolderSize={calcFolderSize}
                  calcSizeKey={calcSizeKey}
                  navigateTo={navigateTo}
                  storageId={storage.id}
                />
              ))}
            </SortableContext>
          </div>
          <DragOverlay>
            {activeDragItem ? (
              <div className="w-36 h-40 bg-white dark:bg-zinc-800 border-2 border-blue-500 rounded-xl shadow-2xl flex flex-col items-center justify-center gap-2 p-4 transform scale-110">
                {activeDragItem.isDirectory ? (
                  <Folder className="h-12 w-12 text-blue-500" />
                ) : (
                  <span className="text-zinc-400">{getFileIcon(activeDragItem.name, "h-12 w-12")}</span>
                )}
                <span className="text-zinc-700 dark:text-zinc-200 text-xs font-medium truncate w-full text-center">
                  {activeDragItem.name}
                </span>
                <div className="text-[10px] text-zinc-400">
                  {activeDragItem.isDirectory ? '文件夹' : formatBytes(activeDragItem.size || 0)}
                </div>
              </div>
            ) : null}
          </DragOverlay>
          </DndContext>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-zinc-50/95 dark:bg-zinc-900/95 backdrop-blur">
              <tr>
                {isAdmin && (
                  <th className="py-2.5 px-3 w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 accent-blue-600"
                    />
                  </th>
                )}
                <th
                  className="text-left py-2.5 px-4 font-medium uppercase tracking-wider cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-300"
                  onClick={() => handleSort('name')}
                >
                  名称
                  {sortKey === 'name' && (sortOrder === 'asc' ? ' ▲' : ' ▼')}
                </th>
                <th
                  className="text-right py-2.5 px-4 font-medium uppercase tracking-wider w-28 cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-300"
                  onClick={() => handleSort('size')}
                >
                  大小
                  {sortKey === 'size' && (sortOrder === 'asc' ? ' ▲' : ' ▼')}
                </th>
                <th
                  className="text-right py-2.5 px-4 font-medium uppercase tracking-wider w-44 cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-300"
                  onClick={() => handleSort('modified')}
                >
                  修改时间
                  {sortKey === 'modified' &&
                    (sortOrder === 'asc' ? ' ▲' : ' ▼')}
                </th>
                <th className="text-right py-2.5 px-4 font-medium uppercase tracking-wider w-36">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <SortableContext items={visibleObjects.map((o) => o.key)} strategy={verticalListSortingStrategy}>
                {visibleObjects.length === 0 ? (
                  <tr>
                    <td
                      colSpan={isAdmin ? 5 : 4}
                      className="py-8 text-center text-zinc-400 dark:text-zinc-600"
                    >
                      没有匹配的文件
                    </td>
                  </tr>
                ) : (
                  visibleObjects.map((obj, i) => (
                    <SortableRow
                      key={obj.key}
                      obj={obj}
                      index={i}
                      isAdmin={isAdmin}
                      canDownload={canDownload}
                      selectedKeys={selectedKeys}
                      cursor={cursor}
                      toggleSelect={toggleSelect}
                      toggleFavorite={toggleFavorite}
                      isFavorite={isFavorite}
                      handlePreview={handlePreview}
                      downloadFile={downloadFile}
                      startShare={startShare}
                      startRename={startRename}
                      startMove={startMove}
                      deleteFolder={deleteFolder}
                      calcFolderSize={calcFolderSize}
                      calcSizeKey={calcSizeKey}
                      navigateTo={navigateTo}
                    />
                  ))
                )}
              </SortableContext>
            </tbody>
            <DragOverlay>
              {activeDragItem ? (
                <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 text-sm">
                  {activeDragItem.isDirectory ? (
                    <Folder className="h-4 w-4 text-blue-500" />
                  ) : (
                    <span className="text-zinc-400">{getFileIcon(activeDragItem.name)}</span>
                  )}
                  <span className="text-zinc-700 dark:text-zinc-200 truncate max-w-[200px]">
                    {activeDragItem.name}
                  </span>
                </div>
              ) : null}
            </DragOverlay>
          </table>
          </DndContext>
        )}
      </div>

      {/* File Preview Modal */}
      {previewFile && (
        <FilePreview
          storageId={storage.id}
          fileKey={previewFile.key}
          fileName={previewFile.name}
          onClose={() => setPreviewFile(null)}
          onPrev={handlePrevPreview}
          onNext={handleNextPreview}
          hasPrev={currentPreviewIndex > 0}
          hasNext={currentPreviewIndex < previewableFiles.length - 1}
          canEdit={canUpload}
          onFileChanged={loadFiles}
        />
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <Modal title="重命名" onClose={() => setRenameTarget(null)}>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">
                新名称
              </label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                className="field"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setRenameTarget(null)}
                className="btn btn-outline flex-1 py-2"
              >
                取消
              </button>
              <button
                onClick={handleRename}
                disabled={renaming || !renameValue.trim()}
                className="btn btn-primary flex-1 py-2"
              >
                {renaming ? '处理中…' : '确定'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Share Modal */}
      {shareTarget && (
        <Modal title="生成分享链接" onClose={() => setShareTarget(null)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">
              分享:{' '}
              <span className="text-zinc-700 dark:text-zinc-300">
                {shareTarget.name}
              </span>
            </div>

            {!shareUrl ? (
              <>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    自定义分享令牌（可选）
                  </label>
                  <input
                    type="text"
                    value={customShareToken}
                    onChange={(e) => setCustomShareToken(e.target.value)}
                    placeholder="留空则自动生成"
                    className="field"
                  />
                  <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                    仅支持字母、数字、下划线和短横线，且不能重复
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    过期时间
                  </label>
                  <select
                    value={shareExpireHours}
                    onChange={(e) =>
                      setShareExpireHours(parseInt(e.target.value, 10))
                    }
                    className="field"
                  >
                    <option value={0}>永不过期</option>
                    <option value={1}>1 小时</option>
                    <option value={24}>1 天</option>
                    <option value={168}>1 周</option>
                    <option value={720}>1 月</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    访问密码（可选）
                  </label>
                  <input
                    type="text"
                    value={sharePassword}
                    onChange={(e) => setSharePassword(e.target.value)}
                    placeholder="留空则无需密码"
                    className="field"
                  />
                  <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                    设置后，访客需输入密码才能访问分享内容
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShareTarget(null)}
                    className="btn btn-outline flex-1 py-2"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleCreateShare}
                    disabled={creatingShare}
                    className="btn btn-primary flex-1 py-2"
                  >
                    {creatingShare ? '生成中…' : '生成链接'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      分享令牌
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={shareToken}
                        readOnly
                        className="field flex-1 text-xs"
                      />
                      <button
                        onClick={() => copyToClipboard(shareToken)}
                        className="btn btn-outline py-2"
                      >
                        <Copy />
                        复制
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1.5">
                      分享链接
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={shareUrl}
                        readOnly
                        className="field flex-1 text-xs"
                      />
                      <button
                        onClick={() => copyToClipboard(shareUrl)}
                        className="btn btn-outline py-2"
                      >
                        <Copy />
                        复制
                      </button>
                    </div>
                  </div>
                  {shareQrCode && (
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1.5">
                        扫码访问
                      </label>
                      <div className="flex justify-center">
                        <img
                          src={shareQrCode}
                          alt="分享二维码"
                          className="w-44 h-44 rounded-lg bg-white p-2"
                        />
                      </div>
                    </div>
                  )}
                  {shareExpiresAt && (
                    <ShareExpiryCountdown expiresAt={shareExpiresAt} />
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleRevokeShare}
                    className="btn btn-danger flex-1 py-2"
                  >
                    撤销分享
                  </button>
                  <button
                    onClick={() => setShareTarget(null)}
                    className="btn btn-primary flex-1 py-2"
                  >
                    完成
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* Move Modal */}
      {moveTarget && (
        <Modal title="移动到" onClose={() => setMoveTarget(null)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">
              移动:{' '}
              <span className="text-zinc-700 dark:text-zinc-300">
                {moveTarget.name}
              </span>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">
                目标文件夹
              </label>
              <select
                value={moveDestPath}
                onChange={(e) => setMoveDestPath(e.target.value)}
                className="field"
              >
                {allFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder === '' ? '/ (根目录)' : '/' + folder}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setMoveTarget(null)}
                className="btn btn-outline flex-1 py-2"
              >
                取消
              </button>
              <button
                onClick={handleMove}
                disabled={moving}
                className="btn btn-primary flex-1 py-2"
              >
                {moving ? '处理中…' : '确定'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Batch Move Modal */}
      {batchMoveOpen && (
        <Modal title="批量移动到" onClose={() => setBatchMoveOpen(false)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">
              将 {selectedKeys.size} 个选中项目移动到：
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">
                目标文件夹
              </label>
              <select
                value={batchMoveDest}
                onChange={(e) => setBatchMoveDest(e.target.value)}
                className="field"
              >
                {allFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder === '' ? '/ (根目录)' : '/' + folder}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setBatchMoveOpen(false)}
                className="btn btn-outline flex-1 py-2"
              >
                取消
              </button>
              <button
                onClick={handleBatchMove}
                disabled={batchMoving}
                className="btn btn-primary flex-1 py-2"
              >
                {batchMoving ? '处理中…' : '确定'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Batch Copy Modal */}
      {batchCopyOpen && (
        <Modal title="批量复制到" onClose={() => setBatchCopyOpen(false)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">
              将 {selectedKeys.size} 个选中项目复制到（保留原文件）：
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">
                目标文件夹
              </label>
              <select
                value={batchCopyDest}
                onChange={(e) => setBatchCopyDest(e.target.value)}
                className="field"
              >
                {allFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder === '' ? '/ (根目录)' : '/' + folder}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setBatchCopyOpen(false)}
                className="btn btn-outline flex-1 py-2"
              >
                取消
              </button>
              <button
                onClick={handleBatchCopy}
                disabled={batchCopying}
                className="btn btn-primary flex-1 py-2"
              >
                {batchCopying ? '处理中…' : '确定'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Context Menu（右键） */}
      {contextMenu &&
        (() => {
          const obj = contextMenu.obj;
          const x = contextMenu.x;
          const y = contextMenu.y;
          const close = () => setContextMenu(null);
          const Item = ({
            icon,
            label,
            onClick,
            danger,
          }: {
            icon: React.ReactNode;
            label: string;
            onClick: () => void;
            danger?: boolean;
          }) => (
            <button
              onClick={onClick}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 ${danger ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-200'}`}
            >
              {icon}
              <span>{label}</span>
            </button>
          );
          return (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={close}
                onContextMenu={(e) => {
                  e.preventDefault();
                  close();
                }}
              />
              <div
                className="fixed z-50 min-w-[160px] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg py-1"
                style={{
                  left: Math.min(x, window.innerWidth - 180),
                  top: Math.min(y, window.innerHeight - 320),
                }}
              >
                {obj.isDirectory ? (
                  <Item
                    icon={<Folder className="h-4 w-4 text-blue-500" />}
                    label="打开"
                    onClick={() => {
                      navigateTo(obj.key);
                      close();
                    }}
                  />
                ) : isPreviewable(obj.name) ? (
                  <Item
                    icon={<Play className="h-4 w-4" />}
                    label="预览"
                    onClick={() => {
                      handlePreview(obj);
                      close();
                    }}
                  />
                ) : null}
                {!obj.isDirectory && (
                  <Item
                    icon={<Download className="h-4 w-4" />}
                    label="下载"
                    onClick={() => {
                      downloadFile(obj.key);
                      close();
                    }}
                  />
                )}
                {obj.isDirectory && canDownload && (
                  <Item
                    icon={<Calculator className="h-4 w-4" />}
                    label={calcSizeKey === obj.key ? '统计中…' : '统计大小'}
                    onClick={() => {
                      calcFolderSize(obj.key, obj.name);
                      close();
                    }}
                  />
                )}
                <Item
                  icon={
                    <Star
                      className={`h-4 w-4 ${isFavorite(obj.key) ? 'text-yellow-500' : ''}`}
                    />
                  }
                  label={isFavorite(obj.key) ? '取消收藏' : '收藏'}
                  onClick={() => {
                    toggleFavorite(obj);
                    close();
                  }}
                />
                {isAdmin && (
                  <>
                    <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
                    <Item
                      icon={<Share2 className="h-4 w-4" />}
                      label="分享"
                      onClick={() => {
                        startShare(obj);
                        close();
                      }}
                    />
                    <Item
                      icon={<Pencil className="h-4 w-4" />}
                      label="重命名"
                      onClick={() => {
                        startRename(obj);
                        close();
                      }}
                    />
                    <Item
                      icon={<ArrowRightLeft className="h-4 w-4" />}
                      label="移动"
                      onClick={() => {
                        startMove(obj);
                        close();
                      }}
                    />
                    <Item
                      icon={<Trash2 className="h-4 w-4" />}
                      label="删除"
                      danger
                      onClick={() => {
                        if (obj.isDirectory) {
                          deleteFolder(obj.key, obj.name);
                        } else {
                          deleteFile(obj.key);
                        }
                        close();
                      }}
                    />
                  </>
                )}
              </div>
            </>
          );
        })()}

      {/* Folder Stats Modal */}
      {folderStats && (
        <FolderStatsModal
          name={folderStats.name}
          stats={folderStats.stats}
          onClose={() => setFolderStats(null)}
        />
      )}

      {/* ⌘K Command Palette */}
      {cmdOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-sm flex items-start justify-center pt-[12vh] p-4"
          onClick={() => setCmdOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 border-b border-zinc-200 dark:border-zinc-700">
              <Search className="h-4 w-4 text-zinc-400 shrink-0" />
              <input
                autoFocus
                value={cmdQuery}
                onChange={(e) => {
                  setCmdQuery(e.target.value);
                  setCmdIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCmdIndex((i) =>
                      Math.min(i + 1, flatCmdItems.length - 1),
                    );
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCmdIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (flatCmdItems[cmdIndex])
                      execCmdItem(flatCmdItems[cmdIndex]);
                  } else if (e.key === 'Escape') {
                    setCmdOpen(false);
                  }
                }}
                placeholder="搜索文件或命令…"
                className="w-full py-3 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none"
              />
              <kbd className="text-[10px] text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-0.5">
                ESC
              </kbd>
            </div>
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {flatCmdItems.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <div className="text-xs text-zinc-400 mb-2">找不到匹配的结果</div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    尝试使用更简单的关键词，或按 ⌘K 返回主命令
                  </div>
                </div>
              ) : (
                flatCmdItems.map((item, i) => {
                  const Icon = item.kind === 'cmd' ? item.icon : null;
                  const FileIcon =
                    item.kind === 'file' && !item.obj.isDirectory
                      ? fileTypeIcon(getFileType(item.obj.name))
                      : null;
                  return (
                    <button
                      key={i}
                      onMouseEnter={() => setCmdIndex(i)}
                      onClick={() => execCmdItem(item)}
                      className={`flex items-center gap-3 w-full px-4 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ${i === cmdIndex ? 'bg-blue-500/10 text-blue-600 dark:text-blue-300' : 'text-zinc-700 dark:text-zinc-200'} ${item.kind === 'cmd' && item.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {item.kind === 'cmd' && Icon ? (
                        <Icon className="h-4 w-4 shrink-0" />
                      ) : item.kind === 'file' ? (
                        item.obj.isDirectory ? (
                          <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                        ) : FileIcon ? (
                          <FileIcon className="h-4 w-4 text-zinc-400 shrink-0" />
                        ) : null
                      ) : (
                        <Star className="h-4 w-4 text-yellow-500 shrink-0" />
                      )}
                      <span className="truncate flex-1">
                        {item.kind === 'cmd'
                          ? item.label
                          : item.kind === 'file'
                            ? item.obj.name
                            : item.fav.name}
                      </span>
                      {item.kind === 'file' && item.obj.isDirectory && (
                        <span className="text-xs text-zinc-400 ml-auto">文件夹</span>
                      )}
                      {item.kind === 'fav' && (
                        <span className="text-xs text-zinc-400 ml-auto">收藏</span>
                      )}
                      {item.kind === 'cmd' && (
                        <kbd className="ml-auto text-[10px] text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-0.5">
                          ⌘{item.id.length}
                        </kbd>
                      )}
                    </button>
                  );
                })
              )}
            </div>
            <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-700 flex items-center gap-4 text-[11px] text-zinc-400">
              <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">↑↓ 导航</span>
              <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">↵ 执行</span>
              <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">esc 关闭</span>
              <span className="ml-auto text-blue-600 dark:text-blue-400">⌘K 呼出</span>
            </div>
          </div>
        </div>
      )}

      {(scanning || scanResults) && (
        <ScanModal
          results={scanResults}
          scanning={scanning}
          onNavigate={navigateToParent}
          onClose={() => {
            setScanResults(null);
            setScanning(false);
          }}
        />
      )}
    </div>
  );
}

// 分享过期倒计时：每秒刷新剩余时间
function ShareExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(
    () => new Date(expiresAt).getTime() - Date.now(),
  );
  useEffect(() => {
    const t = setInterval(
      () => setRemaining(new Date(expiresAt).getTime() - Date.now()),
      1000,
    );
    return () => clearInterval(t);
  }, [expiresAt]);

  if (remaining <= 0) {
    return (
      <div className="text-xs text-red-500 dark:text-red-400 font-medium">
        该分享已过期
      </div>
    );
  }
  const total = Math.floor(remaining / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const text =
    d > 0
      ? `${d}天 ${h}小时 ${m}分 ${s}秒`
      : h > 0
        ? `${h}小时 ${m}分 ${s}秒`
        : `${m}分 ${s}秒`;
  return (
    <div className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded p-2">
      剩余有效时间：
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {text}
      </span>
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const [isAdmin, setIsAdmin] = useState(loaderData.isAdmin);
  const [storages, setStorages] = useState<StorageInfo[]>(loaderData.storages);
  const [selectedStorage, setSelectedStorage] = useState<StorageInfo | null>(
    null,
  );
  const [showLogin, setShowLogin] = useState(false);
  const [showStorageForm, setShowStorageForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [statsStorage, setStatsStorage] = useState<StorageInfo | null>(null);
  const [editingStorage, setEditingStorage] = useState<StorageInfo | null>(
    null,
  );
  const [isDark, setIsDark] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const siteTitle = loaderData.siteTitle || 'Starx';
  const siteAnnouncement = loaderData.siteAnnouncement || '';
  const chunkSizeMB = loaderData.chunkSizeMB || 50;
  const webdavEnabled = loaderData.webdavEnabled || false;

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') {
      setIsDark(false);
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }

    // Show announcement on first visit (per session)
    if (siteAnnouncement) {
      const announcementShown = sessionStorage.getItem('announcement_shown');
      if (!announcementShown) {
        setShowAnnouncement(true);
        sessionStorage.setItem('announcement_shown', 'true');
      }
    }
  }, [siteAnnouncement]);

  // OAuth 回调结果提示（授权完成后各提供商重定向回首页）
  // 弹窗内处理：显示结果后自动关闭弹窗；主窗口通过 postMessage 触发存储刷新
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (!oauth) {
      return;
    }
    if (oauth === 'google-success') {
      toast('Google Drive 授权成功，刷新令牌已保存', 'success');
    } else if (oauth === 'google-error') {
      toast(
        `Google Drive 授权失败：${params.get('reason') || '未知错误'}`,
        'error',
      );
    } else if (oauth === 'microsoft-success') {
      toast('OneDrive 授权成功，令牌已保存', 'success');
    } else if (oauth === 'microsoft-error') {
      toast(
        `OneDrive 授权失败：${params.get('reason') || '未知错误'}`,
        'error',
      );
    } else if (oauth === 'cloudflare-success') {
      toast('Cloudflare R2 授权成功，令牌已保存', 'success');
    } else if (oauth === 'cloudflare-error') {
      toast(
        `Cloudflare R2 授权失败：${params.get('reason') || '未知错误'}`,
        'error',
      );
    }
    params.delete('oauth');
    params.delete('reason');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      query ? `?${query}` : window.location.pathname,
    );
    // 该窗口若是 OAuth 弹窗（脚本打开的窗口可自关），处理完自动关闭
    if (window.opener === null) {
      window.close();
    }
  }, [toast]);

  const toggleTheme = useCallback(
    (event: React.MouseEvent) => {
      const newIsDark = !isDark;

      const changeTheme = () => {
        setIsDark(newIsDark);
        if (newIsDark) {
          document.documentElement.classList.add('dark');
          localStorage.setItem('theme', 'dark');
        } else {
          document.documentElement.classList.remove('dark');
          localStorage.setItem('theme', 'light');
        }
      };

      if (!document.startViewTransition) {
        changeTheme();
        return;
      }

      const x = event.clientX;
      const y = event.clientY;
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );

      const transition = document.startViewTransition(() => {
        changeTheme();
      });

      transition.ready.then(() => {
        const clipPath = [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${endRadius}px at ${x}px ${y}px)`,
        ];
        document.documentElement.animate(
          { clipPath: isDark ? clipPath : clipPath.reverse() },
          {
            duration: 400,
            easing: 'ease-in-out',
            pseudoElement: isDark
              ? '::view-transition-new(root)'
              : '::view-transition-old(root)',
          },
        );
      });
    },
    [isDark],
  );

  const refreshStorages = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/storages');
      if (res.ok) {
        const data = (await res.json()) as {
          storages: StorageInfo[];
          isAdmin: boolean;
        };
        setStorages(data.storages);
        setIsAdmin(data.isAdmin);
      }
    } catch {
      /* ignore */
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      });
      setIsAdmin(false);
      setSelectedStorage(null);
      refreshStorages();
    } catch {
      /* ignore */
    }
  };

  const handleDeleteStorage = async (s: StorageInfo) => {
    const ok = await confirm({
      title: '删除存储',
      message: `删除存储 "${s.name}"？此操作会同时移除其分享链接，但不会删除云端文件。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/storages?id=${s.id}`, { method: 'DELETE' });
      if (res.ok) {
        if (selectedStorage?.id === s.id) setSelectedStorage(null);
        refreshStorages();
        toast(`已删除存储 "${s.name}"`, 'success');
      } else {
        toast('删除存储失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-zinc-100 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <div className="px-4 py-2.5 flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowSidebar(true)}
              className="icon-btn h-9 w-9 md:hidden"
              title="打开存储列表"
              aria-label="打开存储列表"
            >
              <PanelLeft />
            </button>
            <div className="flex items-center gap-2 shrink-0">
              <Logo />
            </div>
          </div>
          <div className="flex-1 text-center min-w-0">
            <span className="text-sm text-zinc-500 dark:text-zinc-400 truncate block">
              {siteTitle}
            </span>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 md:gap-3 shrink-0">
            <button
              onClick={toggleTheme}
              className="icon-btn h-8 w-8 sm:h-9 sm:w-9"
              title={isDark ? '切换到亮色' : '切换到暗色'}
              aria-label="切换主题"
            >
              {isDark ? <Sun /> : <Moon />}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="icon-btn h-8 w-8 sm:h-9 sm:w-9"
              title="设置"
              aria-label="设置"
            >
              <SlidersHorizontal />
            </button>
            {isAdmin ? (
              <>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  管理员
                </span>
                <button
                  onClick={handleLogout}
                  className="icon-btn h-7 w-7 md:hidden"
                  title="登出"
                  aria-label="登出"
                >
                  <LogOut />
                </button>
                <button
                  onClick={handleLogout}
                  className="btn btn-sm btn-ghost hidden sm:inline-flex"
                  title="登出"
                >
                  <LogOut />
                  登出
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowLogin(true)}
                  className="icon-btn h-7 w-7 md:hidden"
                  title="登录"
                  aria-label="登录"
                >
                  <LogIn />
                </button>
                <button
                  onClick={() => setShowLogin(true)}
                  className="btn btn-sm btn-ghost hidden sm:inline-flex"
                  title="登录"
                >
                  <LogIn />
                  登录
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar Overlay for mobile */}
        {showSidebar && (
          <div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden transition-opacity duration-300"
            onClick={() => setShowSidebar(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar - responsive: mobile overlay, desktop fixed */}
        <aside
          className={`${
            showSidebar ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          } ${
            sidebarCollapsed && !showSidebar ? 'md:w-0' : 'md:w-64'
          } border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 flex flex-col transition-all duration-300 overflow-hidden absolute inset-y-0 left-0 z-40 w-64 md:relative md:shrink-0`}
          style={{ top: '0' }}
        >
          <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
            <div className="flex flex-col">
              <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider whitespace-nowrap">
                存储列表
              </span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                {storages.length} 个存储
              </span>
            </div>
            <div className="flex items-center gap-1">
              {isAdmin && (
                <button
                  onClick={() => {
                    setEditingStorage(null);
                    setShowStorageForm(true);
                  }}
                  className="icon-btn h-8 w-8 text-blue-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-500/10 transition-all duration-200 hover:scale-105 active:scale-95"
                  title="添加存储"
                  aria-label="添加存储"
                >
                  <Plus />
                </button>
              )}
              <button
                onClick={() => setShowSidebar(false)}
                className="icon-btn h-8 w-8 md:hidden rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all duration-200 hover:scale-105 active:scale-95"
                title="收起侧边栏"
                aria-label="收起侧边栏"
              >
                <X />
              </button>
              <button
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className="icon-btn h-8 w-8 hidden md:inline-flex rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all duration-200 hover:scale-105 active:scale-95"
                title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              >
                {sidebarCollapsed ? <ChevronRight /> : <ChevronLeft />}
              </button>
            </div>
          </div>
          <div className="overflow-y-auto flex-1 py-1">
            {isLoading ? (
              <div className="px-2 py-1.5 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <div className="h-5 w-5 rounded-full bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                    <div className="flex-1">
                      <div className="h-3.5 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse mb-1.5" />
                      <div className="h-2.5 rounded bg-zinc-200/60 dark:bg-zinc-800/60 animate-pulse w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : storages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <div className="p-4 rounded-2xl bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 shadow-sm border border-zinc-200/50 dark:border-zinc-700/50 mb-3">
                  <FolderPlus className="h-7 w-7 text-zinc-500 dark:text-zinc-400" />
                </div>
                <div className="mb-3">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-2">暂无存储</p>
                  {isAdmin && (
                    <button
                      onClick={() => {
                        setEditingStorage(null);
                        setShowStorageForm(true);
                      }}
                      className="group inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/25 active:scale-[0.98] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 dark:focus:ring-blue-400"
                    >
                      <Plus className="h-4 w-4 transition-transform group-hover:scale-110" />
                      添加存储
                    </button>
                  )}
                </div>
              </div>
            ) : (
              storages.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between mx-1 my-0.5 rounded-xl pl-3 pr-1.5 py-2.5 cursor-pointer transition-all duration-200 ${
                    selectedStorage?.id === s.id
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
                      : 'hover:bg-zinc-100 hover:shadow-sm dark:hover:bg-zinc-800/60'
                  }`}
                  onClick={() => setSelectedStorage(s)}
                  onTouchStart={() => setSelectedStorage(s)}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm font-medium truncate ${selectedStorage?.id === s.id ? '' : 'text-zinc-700 dark:text-zinc-300'}`}
                    >
                      {s.name}
                    </div>
                    <span
                      className={`mt-0.5 inline-flex items-center gap-1 text-xs ${s.isPublic ? 'text-green-600 dark:text-green-400' : 'text-zinc-400 dark:text-zinc-500'}`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${s.isPublic ? 'bg-green-500' : 'bg-zinc-400 dark:bg-zinc-600'}`}
                      />
                      {s.isPublic ? '公开' : '私有'}
                    </span>
                  </div>
                  {isAdmin && (
                    <div
                      className="flex items-center gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => {
                          setStatsStorage(s);
                          setShowStats(true);
                        }}
                        className="icon-btn h-7 w-7"
                        title="统计"
                        aria-label="统计"
                      >
                        <BarChart3 />
                      </button>
                      <button
                        onClick={() => {
                          setEditingStorage(s);
                          setShowStorageForm(true);
                        }}
                        className="icon-btn h-7 w-7"
                        title="编辑"
                        aria-label="编辑"
                      >
                        <Pencil />
                      </button>
                      <button
                        onClick={() => handleDeleteStorage(s)}
                        className="icon-btn h-7 w-7 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                        title="删除"
                        aria-label="删除"
                      >
                        <Trash2 />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Sidebar Expand Button - only show when collapsed on desktop */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 grid h-10 w-8 place-items-center rounded-r-md bg-white dark:bg-zinc-800 border border-l-0 border-zinc-200 dark:border-zinc-700 text-zinc-500 shadow-sm hover:text-blue-500 transition-all duration-200 hover:scale-110 active:scale-105 hidden md:inline-flex"
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}

        {/* Main */}
        <main className="flex-1 bg-zinc-50 dark:bg-zinc-900 min-w-0 overflow-hidden">
          <div className="h-full flex flex-col">
            {selectedStorage ? (
              selectedStorage.type === 'mysql' ? (
                <div className="flex items-center justify-center h-full">
                  <div className="flex flex-col items-center gap-4 text-center p-6">
                    <div className="p-3 rounded-full bg-blue-50 dark:bg-blue-500/10">
                      <Play className="h-6 w-6 text-blue-500" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <h3 className="text-lg font-semibold text-zinc-800 dark:text-zinc-200">
                        {selectedStorage.name}
                      </h3>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        MySQL 浏览器已准备就绪
                      </p>
                    </div>
                    <a
                      href={`/mysql/${selectedStorage.id}`}
                      className="group inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/25 active:scale-[0.98] transition-all duration-200 font-medium"
                    >
                      <Play className="h-5 w-5 transition-transform group-hover:scale-110" />
                      前往 MySQL 浏览器
                    </a>
                  </div>
                </div>
              ) : (
                <FileBrowser
                  storage={selectedStorage}
                  isAdmin={isAdmin}
                  isDark={isDark}
                  chunkSizeMB={chunkSizeMB}
                />
              )
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-6 text-zinc-400 dark:text-zinc-600 bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 select-none">
                <div className="group relative">
                  <div className="p-4 rounded-2xl bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 shadow-sm border border-zinc-200/50 dark:border-zinc-700/50">
                    <Folder className="h-8 w-8 text-zinc-500 dark:text-zinc-400" />
                  </div>
                  <div className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 to-purple-500/20 rounded-2xl blur opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                </div>
                <div className="flex flex-col items-center gap-3">
                  <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-200 tracking-tight">
                    欢迎使用 Starx
                  </h2>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-xs leading-relaxed">
                    添加存储空间，开始浏览和管理您的文件
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2 pt-2">
                  <div className="flex items-center gap-2">
                    <div className="px-3 py-1 rounded-full bg-blue-50 dark:bg-blue-500/10 border border-blue-100 dark:border-blue-500/20">
                      <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">支持 S3、MinIO</span>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-green-50 dark:bg-green-500/10 border border-green-100 dark:border-green-500/20">
                      <span className="text-xs text-green-600 dark:text-green-400 font-medium">云存储聚合</span>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">
                    支持多种存储类型，一站式管理
                  </p>
                </div>
                {isAdmin && (
                  <div className="mt-2">
                    <button
                      onClick={() => {
                        setEditingStorage(null);
                        setShowStorageForm(true);
                      }}
                      className="group relative inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/25 active:scale-[0.98] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-blue-400 dark:bg-blue-600 dark:hover:bg-blue-500 font-medium overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-blue-600 to-blue-500 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                      <Plus className="h-5 w-5 transition-transform group-hover:scale-110 relative z-10" />
                      <span className="relative z-10">添加存储</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Footer */}
      <footer className="shrink-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-2">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-500">
          <span className="flex items-center gap-1.5">
            {storages.length > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                <Folder className="h-3 w-3" />
                {storages.length} 个存储
              </span>
            )}
          </span>
          <span className="opacity-60">云存储聚合工具</span>
        </div>
      </footer>

      {/* Modals */}
      {showLogin && (
        <LoginModal
          onLogin={() => {
            setShowLogin(false);
            refreshStorages();
            setIsAdmin(true);
          }}
          onClose={() => setShowLogin(false)}
        />
      )}
      {showStorageForm && (
        <StorageModal
          storage={editingStorage || undefined}
          onSave={() => {
            setShowStorageForm(false);
            setEditingStorage(null);
            refreshStorages();
          }}
          onCancel={() => {
            setShowStorageForm(false);
            setEditingStorage(null);
          }}
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          siteTitle={siteTitle}
          siteAnnouncement={siteAnnouncement}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          isAdmin={isAdmin}
          onRefreshStorages={refreshStorages}
          webdavEnabled={webdavEnabled}
          storages={storages}
        />
      )}
      {showAnnouncement && siteAnnouncement && (
        <AnnouncementModal
          announcement={siteAnnouncement}
          onClose={() => setShowAnnouncement(false)}
        />
      )}
      {showChangelog && (
        <ChangelogModal onClose={() => setShowChangelog(false)} />
      )}
      {showStats && statsStorage && (
        <StorageStatsModal
          storage={statsStorage}
          onClose={() => {
            setShowStats(false);
            setStatsStorage(null);
          }}
        />
      )}
      {showHelp && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800">
              <h2 className="text-lg font-semibold">键盘快捷键</h2>
              <button
                onClick={() => setShowHelp(false)}
                className="icon-btn h-8 w-8"
              >
                <X />
              </button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[calc(80vh-60px)]">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <h3 className="font-medium text-sm text-zinc-600 dark:text-zinc-400">导航</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">J / K</kbd>
                      <span className="text-zinc-500">向下 / 向上移动光标</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Enter</kbd>
                      <span className="text-zinc-500">打开 / 预览 / 下载</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">H</kbd>
                      <span className="text-zinc-500">返回上级目录</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">G</kbd>
                      <span className="text-zinc-500">回到根目录</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="font-medium text-sm text-zinc-600 dark:text-zinc-400">选择操作</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Space</kbd>
                      <span className="text-zinc-500">切换选中</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Ctrl+A</kbd>
                      <span className="text-zinc-500">全选当前列表</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Delete</kbd>
                      <span className="text-zinc-500">删除选中项</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Esc</kbd>
                      <span className="text-zinc-500">取消选中 / 关闭弹窗</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="font-medium text-sm text-zinc-600 dark:text-zinc-400">文件管理</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">N</kbd>
                      <span className="text-zinc-500">新建文件夹 (管理员)</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">R</kbd>
                      <span className="text-zinc-500">刷新文件列表</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">/</kbd>
                      <span className="text-zinc-500">聚焦搜索框</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="font-medium text-sm text-zinc-600 dark:text-zinc-400">拖拽排序</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Drag</kbd>
                      <span className="text-zinc-500">拖拽文件/文件夹排序</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <kbd className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs">Tab</kbd>
                      <span className="text-zinc-500">切换列表/画廊视图</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-800 text-center text-xs text-zinc-500">
                <p>提示：在输入框中按 Esc 可退出编辑模式</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
