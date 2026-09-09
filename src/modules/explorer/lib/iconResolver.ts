import { EXT_TO_LANGUAGE_ID } from "./constants";
import {
  materialFileExtensions,
  materialFileNames,
  materialFolderNames,
  materialFolderNamesExpanded,
  materialIconUrls,
  materialLanguageIds,
} from "./materialIconSet";

const DEFAULT_FILE = "document";
const DEFAULT_FOLDER = "folder-base";
const DEFAULT_FOLDER_OPEN = "folder-base-open";
const folderAliases: Record<string, string> = {
  ".anbo": "project",
  ".codex": ".agents",
};

function materialIconUrl(iconName: string): string | null {
  return (
    Object.getOwnPropertyDescriptor(materialIconUrls, iconName)?.value ?? null
  );
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
    const url = materialIconUrl(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = materialFileExtensions[ext];
    if (iconName) {
      const url = materialIconUrl(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = materialLanguageIds[langId];
      if (iconByLang) {
        const url = materialIconUrl(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return materialIconUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();
  const lookupName = folderAliases[lower] ?? lower;

  const mapped = expanded
    ? materialFolderNamesExpanded[lookupName]
    : materialFolderNames[lookupName];
  if (mapped) {
    const url = materialIconUrl(mapped);
    if (url) return url;
  }

  return materialIconUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
