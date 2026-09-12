// File type detection utilities

export type FileType = 'video' | 'audio' | 'image' | 'text' | 'code' | 'markdown' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'archive' | 'unknown';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'm4v', 'flv', 'wmv', '3gp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'webm'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const TEXT_EXTENSIONS = ['txt', 'log', 'rst', 'csv', 'ini', 'cfg', 'conf'];
const MARKDOWN_EXTENSIONS = ['md', 'markdown'];
const CODE_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'scss', 'less',
  'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb',
  'php', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'xml', 'yaml', 'yml', 'toml', 'vue', 'svelte', 'astro',
  'swift', 'kt', 'scala', 'r', 'lua', 'pl', 'ex', 'exs',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'env'
];
const PDF_EXTENSIONS = ['pdf'];
const DOCX_EXTENSIONS = ['docx'];
const XLSX_EXTENSIONS = ['xls', 'xlsx', 'csv'];
const PPTX_EXTENSIONS = ['pptx'];
const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'];

export function getFileExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export function getFileType(filename: string): FileType {
  const ext = getFileExtension(filename);

  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (DOCX_EXTENSIONS.includes(ext)) return 'docx';
  if (XLSX_EXTENSIONS.includes(ext)) return 'xlsx';
  if (PPTX_EXTENSIONS.includes(ext)) return 'pptx';
  if (ARCHIVE_EXTENSIONS.includes(ext)) return 'archive';
  if (MARKDOWN_EXTENSIONS.includes(ext)) return 'markdown';
  if (CODE_EXTENSIONS.includes(ext)) return 'code';
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';

  return 'unknown';
}

export function isPreviewable(filename: string): boolean {
  const type = getFileType(filename);
  return ['video', 'audio', 'image', 'text', 'code', 'markdown', 'pdf', 'docx', 'xlsx', 'pptx', 'archive'].includes(type);
}

export function getMimeType(filename: string): string {
  const ext = getFileExtension(filename);

  const mimeTypes: Record<string, string> = {
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    // Image
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    // Code
    js: 'text/javascript',
    ts: 'text/typescript',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css',
    xml: 'text/xml',
    // PDF
    pdf: 'application/pdf',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

export function getCodeLanguage(filename: string): string {
  const ext = getFileExtension(filename);

  const languages: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    php: 'php',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    bat: 'batch',
    cmd: 'batch',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    markdown: 'markdown',
    vue: 'vue',
    svelte: 'svelte',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    r: 'r',
    lua: 'lua',
    pl: 'perl',
    ex: 'elixir',
    exs: 'elixir',
  };

  return languages[ext] || 'plaintext';
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// 同源内联渲染可能执行脚本的危险类型：上传的 HTML/SVG/XML/JS/CSS 必须强制附件下载
export const UNSAFE_INLINE_TYPES =
  /^(text\/html|text\/xml|application\/xml|image\/svg\+xml|application\/javascript|text\/javascript|text\/css)/i;

export function isUnsafeInlineType(contentType: string): boolean {
  return UNSAFE_INLINE_TYPES.test(contentType);
}

// 文件响应安全头：nosniff 防 MIME 嗅探；内联渲染套 CSP sandbox 沙箱，直接打开 URL 也无法执行脚本
export function fileResponseHeaders(contentType: string, inline: boolean): Record<string, string> {
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (inline && !isUnsafeInlineType(contentType)) {
    headers["Content-Security-Policy"] = "sandbox";
  }
  return headers;
}

export type ByteRange = { start: number; end?: number };

// Range 仅支持单区间；bytes=-N 表示末尾 N 字节，用负 start 表达
export function parseByteRange(header: string | null | undefined): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim().toLowerCase());
  if (!match || (!match[1] && !match[2])) return null;
  return match[1]
    ? { start: Number(match[1]), end: match[2] ? Number(match[2]) : undefined }
    : { start: -Number(match[2]) };
}

// 越界或无法满足的区间返回 null，调用方按完整响应处理
export function resolveByteRange(
  range: ByteRange | null,
  size: number
): { start: number; end: number } | null {
  if (!range || size <= 0) return null;
  const start = range.start < 0 ? Math.max(0, size + range.start) : range.start;
  if (start >= size) return null;
  const end = range.end === undefined ? size - 1 : Math.min(range.end, size - 1);
  return end >= start ? { start, end } : null;
}

// 浏览器拖动进度条时请求 bytes=<offset>-，透传给支持 Range 的存储换回 206 分段内容
export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

// 透传分段响应的 Accept-Ranges 与 Content-Range
export function makeRangeResponseHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = { "Accept-Ranges": "bytes" };
  const contentRange = upstream.get("content-range");
  if (contentRange) {
    headers["Content-Range"] = contentRange;
  }
  return headers;
}

