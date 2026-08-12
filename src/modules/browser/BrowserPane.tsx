import { IS_WINDOWS } from "@/lib/platform";
import { Alert02Icon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useBrowserAutomationActivity } from "./automationActivity";
import {
  BrowserAddressBar,
  type BrowserAddressBarHandle,
} from "./BrowserAddressBar";
import {
  BROWSER_NAV_EVENT,
  type BrowserNavEvent,
  browserEmbedDispatch,
  browserEmbedNavigate,
  browserEmbedRelease,
  browserEmbedSetPunchHole,
  browserEmbedSetUiOverlay,
  browserEmbedSetZoom,
  browserEmbedSnapshot,
  browserEmbedUpdate,
  browserEmbedUrl,
  canMeasureBrowserPane,
  createBrowserOwnerId,
  forgetBrowserOwnerId,
  isSelfReferenceUrl,
  isSupportedBrowserUrl,
  type PunchHole,
  shouldShowBrowserPane,
  toPhysicalBounds,
} from "./native";
import {
  useNativeBrowserDragActive,
  useNativeBrowserOverlayOpen,
} from "./nativeVisibility";

export type BrowserPaneHandle = {
  reload: () => void;
  navigate: (url: string) => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  id: number;
  url: string;
  visible: boolean;
  initialLoading: boolean;
  onUrlChange: (url: string) => void;
  onTitleChange: (title: string) => void;
  onLoadingChange?: (loading: boolean) => void;
};

type DesiredBounds = {
  key: string;
  bounds: ReturnType<typeof toPhysicalBounds>;
  visible: boolean;
};

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };
const mountedOwnerCounts = new Map<number, number>();
const pendingReleases = new Map<number, ReturnType<typeof setTimeout>>();
const visibleNativeBrowsers = new Set<number>();

function syncNativeBrowserSurface(): void {
  if (visibleNativeBrowsers.size > 0) {
    document.documentElement.dataset.nativeBrowserLive = "true";
  } else {
    delete document.documentElement.dataset.nativeBrowserLive;
  }
}

export const BrowserPane = forwardRef<BrowserPaneHandle, Props>(
  function BrowserPane(
    {
      id,
      url,
      visible,
      initialLoading,
      onUrlChange,
      onTitleChange,
      onLoadingChange,
    },
    ref,
  ) {
    const native = isTauri();
    const [iframeNonce, setIframeNonce] = useState(0);
    const [nativeError, setNativeError] = useState<string | null>(null);
    const [freezeFrame, setFreezeFrame] = useState<string | null>(null);
    const addressRef = useRef<BrowserAddressBarHandle>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const ownerIdRef = useRef(createBrowserOwnerId(id));
    const currentUrlRef = useRef(url);
    const urlPropRef = useRef(url);
    const onUrlChangeRef = useRef(onUrlChange);
    const onTitleChangeRef = useRef(onTitleChange);
    const visibleRef = useRef(visible);
    const overlayOpen = useNativeBrowserOverlayOpen(contentRef);
    const overlayOpenRef = useRef(overlayOpen);
    const dragActive = useNativeBrowserDragActive();
    const dragActiveRef = useRef(dragActive);
    const suppressionReadyRef = useRef(false);
    const suppressionRequestRef = useRef(0);
    const sentKeyRef = useRef("");
    const desiredRef = useRef<DesiredBounds | null>(null);
    const inFlightRef = useRef(false);
    const disposedRef = useRef(false);
    const boundsErrorRef = useRef(false);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [zoom, setZoom] = useState(1.0);
    const aiAction = useBrowserAutomationActivity(id);
    const [loading, setLoading] = useState(initialLoading);
    const onLoadingChangeRef = useRef(onLoadingChange);
    const lastHoleRef = useRef("");

    const handleZoom = useCallback(
      (newZoom: number) => {
        setZoom(newZoom);
        if (native) {
          browserEmbedSetZoom(id, ownerIdRef.current, newZoom).catch(
            console.error,
          );
        }
      },
      [id, native],
    );

    onUrlChangeRef.current = onUrlChange;
    onTitleChangeRef.current = onTitleChange;
    urlPropRef.current = url;
    visibleRef.current = visible;
    onLoadingChangeRef.current = onLoadingChange;

    // Propagate the per-tab loading flag up to the tab store (tab spinner).
    useEffect(() => {
      onLoadingChangeRef.current?.(loading);
    }, [loading]);

    // Safety net: the `loaded` page event is unreliable in the native webview
    // (it sometimes never fires), so a tab could otherwise show the loading
    // spinner forever even after the page fully rendered. Force-clear after a
    // grace period. Cleared automatically once loading flips back to false.
    useEffect(() => {
      if (!loading) return;
      const timer = setTimeout(() => setLoading(false), 6000);
      return () => clearTimeout(timer);
    }, [loading]);

    const reportNativeError = useCallback((error: unknown) => {
      boundsErrorRef.current = false;
      setNativeError(error instanceof Error ? error.message : String(error));
    }, []);

    const sendDesiredBounds = useCallback(() => {
      if (!native || disposedRef.current || inFlightRef.current) return;
      const desired = desiredRef.current;
      if (!desired || desired.key === sentKeyRef.current) return;
      sentKeyRef.current = desired.key;
      inFlightRef.current = true;
      void browserEmbedUpdate(
        id,
        ownerIdRef.current,
        currentUrlRef.current,
        desired.bounds,
        desired.visible,
      )
        .then(() => {
          if (disposedRef.current) return;
          if (IS_WINDOWS && overlayOpenRef.current) {
            void browserEmbedSetUiOverlay(id, ownerIdRef.current, true).catch(
              () => {},
            );
          }
          if (boundsErrorRef.current) {
            boundsErrorRef.current = false;
            setNativeError(null);
          }
        })
        .catch((error) => {
          if (disposedRef.current) return;
          boundsErrorRef.current = true;
          setNativeError(
            error instanceof Error ? error.message : String(error),
          );
          const failedKey = desired.key;
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (sentKeyRef.current !== failedKey) return;
            sentKeyRef.current = "";
            sendDesiredBounds();
          }, 1_000);
        })
        .finally(() => {
          inFlightRef.current = false;
          sendDesiredBounds();
        });
    }, [id, native]);

    useEffect(() => {
      if (!native || !IS_WINDOWS || !visible || !url) return;
      visibleNativeBrowsers.add(id);
      syncNativeBrowserSurface();
      return () => {
        visibleNativeBrowsers.delete(id);
        syncNativeBrowserSurface();
      };
    }, [id, native, url, visible]);

    useEffect(() => {
      overlayOpenRef.current = overlayOpen;
      if (!native || !IS_WINDOWS || !visible || !url) return;
      void browserEmbedSetUiOverlay(id, ownerIdRef.current, overlayOpen).catch(
        reportNativeError,
      );
      return () => {
        if (overlayOpen) {
          void browserEmbedSetUiOverlay(id, ownerIdRef.current, false).catch(
            () => {},
          );
        }
      };
    }, [id, native, overlayOpen, reportNativeError, url, visible]);

    const syncBounds = useCallback(() => {
      if (!native) return;
      const element = contentRef.current;
      const currentUrl = currentUrlRef.current;
      const allowedUrl =
        isSupportedBrowserUrl(currentUrl) && !isSelfReferenceUrl(currentUrl);
      const canMeasure = canMeasureBrowserPane(
        document.visibilityState === "visible",
        allowedUrl,
        !!element,
      );
      const rect =
        canMeasure && element ? element.getBoundingClientRect() : null;
      const hasArea = !!rect && rect.width >= 1 && rect.height >= 1;
      const dpr = window.devicePixelRatio || 1;
      const bounds = hasArea ? toPhysicalBounds(rect, dpr) : EMPTY_BOUNDS;
      const shouldShow = shouldShowBrowserPane(
        canMeasure,
        visibleRef.current,
        hasArea,
        suppressionReadyRef.current,
      );
      desiredRef.current = {
        key: shouldShow
          ? `show:${bounds.x},${bounds.y},${bounds.width},${bounds.height}:${currentUrl}`
          : canMeasure && hasArea
            ? `hidden:${bounds.x},${bounds.y},${bounds.width},${bounds.height}:${currentUrl}`
            : "hide",
        bounds,
        visible: shouldShow,
      };
      sendDesiredBounds();

      // Punch a hole through the webview for the AI mini window so it can float
      // over the browser and stay interactive without sinking the whole webview
      // behind the app layer. The hole is the intersection (physical px, relative
      // to the webview's own origin) of the browser content rect and the panel.
      if (IS_WINDOWS) {
        const mini = document.querySelector(
          '[data-ai-mini-window][data-state="open"]',
        ) as HTMLElement | null;
        let hole: PunchHole | null = null;
        if (shouldShow && rect && mini) {
          const m = mini.getBoundingClientRect();
          const ix = Math.max(rect.left, m.left);
          const iy = Math.max(rect.top, m.top);
          const ir = Math.min(rect.right, m.right);
          const ib = Math.min(rect.bottom, m.bottom);
          if (ir > ix && ib > iy) {
            hole = {
              x: Math.round((ix - rect.left) * dpr),
              y: Math.round((iy - rect.top) * dpr),
              width: Math.round((ir - ix) * dpr),
              height: Math.round((ib - iy) * dpr),
            };
          }
        }
        const key = hole
          ? `${hole.x},${hole.y},${hole.width},${hole.height}`
          : "none";
        if (key !== lastHoleRef.current) {
          lastHoleRef.current = key;
          void browserEmbedSetPunchHole(id, ownerIdRef.current, hole).catch(
            () => {},
          );
        }
      }
    }, [id, native, sendDesiredBounds]);

    useEffect(() => {
      if (!native) return;
      if (!visible) {
        syncBounds();
        return;
      }
      let frame = 0;
      let lastSync = 0;
      const tick = (now: number) => {
        if (now - lastSync >= 40) {
          lastSync = now;
          syncBounds();
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [id, native, syncBounds, visible]);

    useEffect(() => {
      disposedRef.current = false;
      if (!native) return;
      const pending = pendingReleases.get(id);
      if (pending) clearTimeout(pending);
      pendingReleases.delete(id);
      mountedOwnerCounts.set(id, (mountedOwnerCounts.get(id) ?? 0) + 1);
      return () => {
        disposedRef.current = true;
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        const ownerId = ownerIdRef.current;
        const remaining = Math.max(0, (mountedOwnerCounts.get(id) ?? 1) - 1);
        if (remaining > 0) {
          mountedOwnerCounts.set(id, remaining);
          return;
        }
        mountedOwnerCounts.delete(id);
        const timer = setTimeout(() => {
          pendingReleases.delete(id);
          if ((mountedOwnerCounts.get(id) ?? 0) > 0) return;
          forgetBrowserOwnerId(id, ownerId);
          void browserEmbedRelease(id, ownerId).catch(() => {});
        }, 0);
        pendingReleases.set(id, timer);
      };
    }, [id, native]);

    useEffect(() => {
      if (!native || !visible) return;
      let alive = true;
      let reading = false;
      const reconcileLiveUrl = () => {
        if (reading) return;
        reading = true;
        void browserEmbedUrl(id, ownerIdRef.current)
          .then((liveUrl) => {
            if (!alive || !liveUrl || liveUrl === currentUrlRef.current) return;
            currentUrlRef.current = liveUrl;
            if (liveUrl !== urlPropRef.current) {
              onUrlChangeRef.current(liveUrl);
            }
          })
          .catch(() => {})
          .finally(() => {
            reading = false;
          });
      };
      const interval = setInterval(reconcileLiveUrl, 1_000);
      return () => {
        alive = false;
        clearInterval(interval);
      };
    }, [id, native, visible]);

    useEffect(() => {
      dragActiveRef.current = dragActive;
      if (!native) return;
      const request = ++suppressionRequestRef.current;
      if (!dragActive) {
        suppressionReadyRef.current = false;
        sentKeyRef.current = "";
        syncBounds();
        return;
      }

      let frame = 0;
      void browserEmbedSnapshot(id, ownerIdRef.current)
        .catch(() => null)
        .then((snapshot) => {
          if (
            disposedRef.current ||
            suppressionRequestRef.current !== request ||
            !dragActiveRef.current
          ) {
            return;
          }
          if (snapshot) setFreezeFrame(snapshot);
          frame = requestAnimationFrame(() => {
            if (
              disposedRef.current ||
              suppressionRequestRef.current !== request ||
              !dragActiveRef.current
            ) {
              return;
            }
            suppressionReadyRef.current = true;
            sentKeyRef.current = "";
            syncBounds();
          });
        });
      return () => {
        if (frame) cancelAnimationFrame(frame);
      };
    }, [dragActive, id, native, syncBounds]);

    useEffect(() => {
      if (!native) return;
      const onVisibilityChange = () => syncBounds();
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () =>
        document.removeEventListener("visibilitychange", onVisibilityChange);
    }, [native, syncBounds]);

    useEffect(() => {
      if (!native) return;
      let alive = true;
      let unlisten: UnlistenFn | undefined;
      void listen<BrowserNavEvent>(BROWSER_NAV_EVENT, ({ payload }) => {
        if (
          !payload ||
          payload.tabId !== id ||
          payload.ownerId !== ownerIdRef.current ||
          !payload.url
        )
          return;
        if (payload.kind === "navigated") {
          setLoading(true);
        } else if (payload.kind === "loaded") {
          setLoading(false);
          return;
        }
        if (payload.kind === "title" && payload.title?.trim()) {
          onTitleChangeRef.current(payload.title.trim().slice(0, 200));
          // The document has a title → it has loaded enough to identify itself.
          // `loaded` is unreliable in the native webview, so treat the title as
          // a secondary signal to stop the spinner once content is present.
          setLoading(false);
        }
        currentUrlRef.current = payload.url;
        if (
          payload.kind === "navigated" ||
          payload.url !== urlPropRef.current
        ) {
          onUrlChangeRef.current(payload.url);
        }
      }).then((dispose) => {
        if (alive) unlisten = dispose;
        else dispose();
      });
      return () => {
        alive = false;
        unlisten?.();
      };
    }, [id, native]);

    useEffect(() => {
      if (!native || !url) return;
      if (!isSupportedBrowserUrl(url)) {
        boundsErrorRef.current = false;
        setNativeError("Only HTTP(S) URLs can load in the browser.");
        return;
      }
      if (isSelfReferenceUrl(url)) {
        boundsErrorRef.current = false;
        setNativeError("Anbo cannot be opened inside its own browser pane.");
        return;
      }
      if (url === currentUrlRef.current) return;
      currentUrlRef.current = url;
      setNativeError(null);
      setLoading(true);
      void browserEmbedNavigate(id, ownerIdRef.current, url).catch(
        reportNativeError,
      );
    }, [id, native, reportNativeError, url]);

    const navigate = useCallback(
      (next: string) => {
        currentUrlRef.current = next;
        onUrlChangeRef.current(next);
        setNativeError(null);
        if (native) {
          if (!isSupportedBrowserUrl(next)) {
            boundsErrorRef.current = false;
            setNativeError("Only HTTP(S) URLs can load in the browser.");
          } else if (isSelfReferenceUrl(next)) {
            boundsErrorRef.current = false;
            setNativeError(
              "Anbo cannot be opened inside its own browser pane.",
            );
          } else {
            setLoading(true);
            void browserEmbedNavigate(id, ownerIdRef.current, next).catch(
              reportNativeError,
            );
          }
          syncBounds();
        }
      },
      [id, native, reportNativeError, syncBounds],
    );

    const dispatch = useCallback(
      (action: "back" | "forward" | "reload") => {
        if (native) {
          setLoading(true);
          void browserEmbedDispatch(id, ownerIdRef.current, action).catch(
            reportNativeError,
          );
        } else if (action === "reload") setIframeNonce((nonce) => nonce + 1);
      },
      [id, native, reportNativeError],
    );

    useImperativeHandle(
      ref,
      () => ({
        reload: () => dispatch("reload"),
        navigate,
        focusAddressBar: () => addressRef.current?.focus(),
        getUrl: () => currentUrlRef.current,
      }),
      [dispatch, navigate],
    );

    const showXfoHint = !native && url ? !isLocalUrl(url) : false;

    return (
      <div
        className={`flex h-full w-full flex-col overflow-hidden ${native ? "bg-transparent" : "bg-background"}`}
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      >
        <BrowserAddressBar
          ref={addressRef}
          url={url}
          onSubmit={navigate}
          onBack={() => dispatch("back")}
          onForward={() => dispatch("forward")}
          onReload={() => dispatch("reload")}
          zoom={zoom}
          onZoom={handleZoom}
          aiAction={aiAction}
        />
        {showXfoHint ? (
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/60 bg-amber-500/8 px-3 text-[11px] text-amber-600 dark:text-amber-400">
            <HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={1.75} />
            <span className="truncate">
              Public sites may refuse the browser-development iframe. Open the
              desktop app for native browsing.
            </span>
          </div>
        ) : null}
        <div
          ref={contentRef}
          className={
            url
              ? native
                ? loading
                  ? "relative min-h-0 flex-1 bg-background" // Solid background while loading
                  : "relative min-h-0 flex-1 bg-transparent" // Transparent once loaded
                : "relative min-h-0 flex-1 bg-white"
              : "relative min-h-0 flex-1 bg-background"
          }
        >
          {native && dragActive && freezeFrame && !nativeError ? (
            <img
              src={freezeFrame}
              alt=""
              aria-hidden
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-fill"
            />
          ) : null}
          {url ? (
            native ? (
              nativeError ? (
                <BrowserError message={nativeError} />
              ) : loading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background z-0">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              ) : null
            ) : (
              <iframe
                key={`${url}#${iframeNonce}`}
                src={url}
                title="Browser"
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
            )
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  },
);

function BrowserError({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card text-amber-500">
        <HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.5} />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Browser unavailable
        </p>
        <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
          {message}
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          Open a browser page
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Enter an HTTP(S) URL or choose a running local development server from
          the Ports menu.
        </p>
      </div>
    </div>
  );
}

function isLocalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
