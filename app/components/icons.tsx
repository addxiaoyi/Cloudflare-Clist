// 统一内联 SVG 图标集（Lucide 风格：24x24 / stroke 2 / currentColor）
// 零依赖，所有图标继承父级 text-* 颜色，按需通过 className 控制 size。

import type { SVGProps } from "react";
import type { FileType } from "~/lib/file-utils";

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/* ---------- 基础操作 ---------- */
export const X = (p: IconProps) => (
  <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>
);
export const Plus = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>
);
export const Check = (p: IconProps) => (
  <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
);
export const Search = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>
);
export const Copy = (p: IconProps) => (
  <Svg {...p}><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></Svg>
);
export const ExternalLink = (p: IconProps) => (
  <Svg {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>
);

/* ---------- 导航 ---------- */
export const ChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>
);
export const ChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>
);
export const ArrowLeft = (p: IconProps) => (
  <Svg {...p}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Svg>
);
export const ArrowRightLeft = (p: IconProps) => (
  <Svg {...p}><path d="m16 3 4 4-4 4" /><path d="M20 7H4" /><path d="m8 21-4-4 4-4" /><path d="M4 17h16" /></Svg>
);
export const RefreshCw = (p: IconProps) => (
  <Svg {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></Svg>
);
export const PanelLeft = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></Svg>
);

/* ---------- 主题 / 账户 / 品牌 ---------- */
export const Sun = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></Svg>
);
export const Moon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Svg>
);
export const SlidersHorizontal = (p: IconProps) => (
  <Svg {...p}><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></Svg>
);
export const LogIn = (p: IconProps) => (
  <Svg {...p}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" x2="3" y1="12" y2="12" /></Svg>
);
export const LogOut = (p: IconProps) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" /></Svg>
);
export const ShieldCheck = (p: IconProps) => (
  <Svg {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></Svg>
);
export const Cloud = (p: IconProps) => (
  <Svg {...p}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></Svg>
);
export const Globe = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></Svg>
);
export const LayoutGrid = (p: IconProps) => (
  <Svg {...p}><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></Svg>
);
export const List = (p: IconProps) => (
  <Svg {...p}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></Svg>
);
export const Star = (p: IconProps) => (
  <Svg {...p}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></Svg>
);
export const Calculator = (p: IconProps) => (
  <Svg {...p}><rect width="16" height="20" x="4" y="2" rx="2" /><line x1="8" x2="16" y1="6" y2="6" /><line x1="16" x2="16" y1="14" y2="18" /><path d="M16 10h.01" /><path d="M12 10h.01" /><path d="M8 10h.01" /><path d="M12 14h.01" /><path d="M8 14h.01" /><path d="M12 18h.01" /><path d="M8 18h.01" /></Svg>
);

/* ---------- 文件操作 ---------- */
export const FolderPlus = (p: IconProps) => (
  <Svg {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6" /><path d="M9 13h6" /></Svg>
);
export const Upload = (p: IconProps) => (
  <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></Svg>
);
export const Download = (p: IconProps) => (
  <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></Svg>
);
export const Share2 = (p: IconProps) => (
  <Svg {...p}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" x2="15.42" y1="13.51" y2="17.49" /><line x1="15.41" x2="8.59" y1="6.51" y2="10.49" /></Svg>
);
export const Pencil = (p: IconProps) => (
  <Svg {...p}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></Svg>
);
export const Trash2 = (p: IconProps) => (
  <Svg {...p}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" /></Svg>
);
export const Play = (p: IconProps) => (
  <Svg {...p}><polygon points="6 3 20 12 6 21 6 3" /></Svg>
);
export const Pause = (p: IconProps) => (
  <Svg {...p}><rect x="14" y="4" width="4" height="16" rx="1" /><rect x="6" y="4" width="4" height="16" rx="1" /></Svg>
);
export const Lock = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>
);
export const Eye = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></Svg>
);
export const EyeClosed = (p: IconProps) => (
  <Svg {...p}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 9.9a4 4 0 0 1 4.2 4.2" /><line x1="1" y1="1" x2="23" y2="23" /></Svg>
);
export const BarChart3 = (p: IconProps) => (
  <Svg {...p}><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></Svg>
);

/* ---------- 文件类型 ---------- */
const FileOutline = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></Svg>
);
export const FileText = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></Svg>
);
export const FileCode = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="m10 12-2 2 2 2" /><path d="m14 16 2-2-2-2" /></Svg>
);
export const FileImage = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><circle cx="10" cy="12" r="1.5" /><path d="m8 20 3-3 2 2 3-4 4 5z" /></Svg>
);
export const FileVideo = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="m10 11 5 3-5 3z" /></Svg>
);
export const FileAudio = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M9 18v-6l5-1v6" /><circle cx="8" cy="18" r="1.5" /><circle cx="13" cy="17" r="1.5" /></Svg>
);
export const FileArchive = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M12 6v2" /><path d="M12 11v1" /><path d="M12 15v1" /></Svg>
);
export const Folder = (p: IconProps) => (
  <Svg {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>
);
// 给需要单独使用文件轮廓的场景
export { FileOutline };

/* ---------- 状态 / 提示 ---------- */
export const Clock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></Svg>
);
export const AlertCircle = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></Svg>
);
export const Link = (p: IconProps) => (
  <Svg {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Svg>
);
export const Megaphone = (p: IconProps) => (
  <Svg {...p}><path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></Svg>
);

/* ---------- 第三方 ---------- */
export const Github = (p: IconProps) => (
  <Svg {...p}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" /></Svg>
);

/* ---------- 文件类型 → 图标映射，供表格使用 ---------- */
export function fileTypeIcon(type: FileType) {
  switch (type) {
    case "image":
      return FileImage;
    case "video":
      return FileVideo;
    case "audio":
      return FileAudio;
    case "code":
    case "markdown":
      return FileCode;
    case "pdf":
    case "text":
    case "docx":
    case "xlsx":
    case "pptx":
      return FileText;
    case "archive":
      return FileArchive;
    default:
      return FileText;
  }
}
