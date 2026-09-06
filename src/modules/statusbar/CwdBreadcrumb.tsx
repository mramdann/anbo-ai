import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  ArrowDown01Icon,
  Folder01Icon,
  Home03Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { DENSE_MENU, DENSE_MENU_ICON, DENSE_MENU_ITEM } from "./lib/denseMenu";
import { segmentsFromCwd } from "./lib/pathUtils";

// One chip per path segment, on the status bar's own 11px scale: a hairline
// border, 20px tall, so the row reads as a path rather than a row of pills.
const CHIP =
  "inline-flex h-5 items-center gap-1 rounded-md border border-border/60 px-1.5 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
// No gap of its own: the chevron box between two chips is all the room
// they get.
const LIST = "gap-0 text-[11px] sm:gap-0";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
};

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

export function CwdBreadcrumb({ cwd, filePath, home, onCd }: Props) {
  // File mode: dir segments navigate; filename is the terminal leaf.
  if (filePath) {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const segments = segmentsFromCwd(dir, home);
    const first = segments[0];
    const middle = segments.slice(1);
    return (
      <Breadcrumb>
        <BreadcrumbList className={LIST}>
          {first ? (
            <BreadcrumbSegment
              label={first.label}
              isHome={first.isHome}
              onClick={() => onCd(first.fullPath)}
            />
          ) : null}
          {middle.length > 0 ? (
            <CollapsedSegments segments={middle} onCd={onCd} />
          ) : null}
          {middle.map((s) => (
            <span key={s.fullPath} className="contents max-md:hidden">
              <BreadcrumbSegment
                label={s.label}
                isHome={s.isHome}
                onClick={() => onCd(s.fullPath)}
              />
            </span>
          ))}
          <BreadcrumbItem>
            <BreadcrumbPage className="px-1 text-[11px] text-foreground">
              {name}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (!cwd) {
    return (
      <span className="text-[11px] text-muted-foreground/70">no directory</span>
    );
  }

  const segments = segmentsFromCwd(cwd, home);
  const current = segments[segments.length - 1];
  const parents = segments.slice(0, -1);

  const firstParent = parents[0];
  const middleParents = parents.slice(1);
  return (
    <Breadcrumb>
      <BreadcrumbList className={LIST}>
        {firstParent ? (
          <BreadcrumbSegment
            label={firstParent.label}
            isHome={firstParent.isHome}
            onClick={() => onCd(firstParent.fullPath)}
          />
        ) : null}
        {middleParents.length > 0 ? (
          <CollapsedSegments segments={middleParents} onCd={onCd} />
        ) : null}
        {middleParents.map((s) => (
          <span key={s.fullPath} className="contents max-md:hidden">
            <BreadcrumbSegment
              label={s.label}
              isHome={s.isHome}
              onClick={() => onCd(s.fullPath)}
            />
          </span>
        ))}
        <BreadcrumbItem>
          <CurrentSegmentDropdown
            label={current.label}
            path={current.fullPath}
            onCd={onCd}
          />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbSegment({
  label,
  isHome,
  onClick,
}: {
  label: string;
  isHome: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <button type="button" onClick={onClick} className={CHIP}>
            {isHome ? (
              <HugeiconsIcon
                icon={Home03Icon}
                className="size-3"
                strokeWidth={1.75}
              />
            ) : null}
            {isHome ? "Home" : label}
          </button>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="size-3.5 opacity-60 [&>svg]:size-3" />
    </>
  );
}

function CurrentSegmentDropdown({
  label,
  path,
  onCd,
}: {
  label: string;
  path: string;
  onCd: (p: string) => void;
}) {
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const dirs = await invoke<string[]>("list_subdirs", {
        path,
        showHidden,
        workspace: currentWorkspaceEnv(),
      });
      setChildren(dirs);
    } catch (e) {
      setError(String(e));
      setChildren([]);
    }
  }, [path, showHidden]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <BreadcrumbPage className="flex h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] leading-none text-foreground hover:bg-accent">
          {label === "~" ? (
            <>
              <HugeiconsIcon
                icon={Home03Icon}
                className="size-3"
                strokeWidth={1.75}
              />
              Home
            </>
          ) : (
            label
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-3 opacity-70"
            strokeWidth={2}
          />
        </BreadcrumbPage>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={`${DENSE_MENU} max-h-72 overflow-y-auto`}
      >
        {children === null ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : children.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {error ?? "No subfolders"}
          </div>
        ) : (
          children.map((name) => (
            <DropdownMenuItem
              key={name}
              className={DENSE_MENU_ITEM}
              onSelect={() =>
                onCd(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`)
              }
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                className={DENSE_MENU_ICON}
                strokeWidth={1.75}
              />
              {name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedSegments({
  segments,
  onCd,
}: {
  segments: { fullPath: string; label: string; isHome: boolean }[];
  onCd: (p: string) => void;
}) {
  return (
    <span className="contents md:hidden">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Folders between"
              className="flex h-5 items-center rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                className="size-3"
                strokeWidth={1.75}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={DENSE_MENU}>
            {segments.map((s) => (
              <DropdownMenuItem
                key={s.fullPath}
                className={DENSE_MENU_ITEM}
                onSelect={() => onCd(s.fullPath)}
              >
                <HugeiconsIcon
                  icon={s.isHome ? Home03Icon : Folder01Icon}
                  className={DENSE_MENU_ICON}
                  strokeWidth={1.75}
                />
                <span className="truncate">{s.isHome ? "Home" : s.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="size-3.5 opacity-60 [&>svg]:size-3" />
    </span>
  );
}
