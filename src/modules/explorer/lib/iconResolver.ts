import { EXT_TO_LANGUAGE_ID } from "./constants";
import {
  materialFileExtensions,
  materialFileNames,
  materialFolderNames,
  materialFolderNamesExpanded,
  materialIconSet,
  materialLanguageIds,
} from "./materialIconSet";

type IconifySet = {
  icons: Record<
    string,
    {
      body: string;
      width?: number;
      height?: number;
      left?: number;
      top?: number;
    }
  >;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
};

const material = materialIconSet as unknown as IconifySet;
const MATERIAL_W = material.width ?? 24;
const MATERIAL_H = material.height ?? 24;

const DEFAULT_FILE = "document";
const DEFAULT_FOLDER = "folder-base";
const DEFAULT_FOLDER_OPEN = "folder-base-open";
const folderAliases: Record<string, string> = {
  ".anbo": "project",
  ".codex": ".agents",
};

const dataUrlCache = new Map<string, string>();

function materialIcon(iconName: string) {
  const direct = material.icons[iconName];
  if (direct) return direct;
  const alias = material.aliases?.[iconName];
  if (alias) {
    const parent = material.icons[alias.parent];
    if (parent) return parent;
  }
  return null;
}

function buildDataUrl(iconName: string): string | null {
  const cached = dataUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const icon = materialIcon(iconName);
  if (!icon) {
    dataUrlCache.set(iconName, "");
    return null;
  }
  const isFolder = iconName.startsWith("folder-") || iconName === "folder";
  const defaultWidth = isFolder ? 16 : MATERIAL_W;
  const defaultHeight = isFolder ? 16 : MATERIAL_H;
  const width = icon.width ?? defaultWidth;
  const height = icon.height ?? defaultHeight;
  const left = icon.left ?? 0;
  const top = icon.top ?? 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${icon.body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  dataUrlCache.set(iconName, url);
  return url;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const byName = materialFileNames[lower];
  if (byName) {
    const url = buildDataUrl(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = materialFileExtensions[ext];
    if (iconName) {
      const url = buildDataUrl(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = materialLanguageIds[langId];
      if (iconByLang) {
        const url = buildDataUrl(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return buildDataUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();
  const lookupName = folderAliases[lower] ?? lower;

  const mapped = expanded
    ? materialFolderNamesExpanded[lookupName]
    : materialFolderNames[lookupName];
  if (mapped) {
    const url = buildDataUrl(mapped);
    if (url) return url;
  }

  return buildDataUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
