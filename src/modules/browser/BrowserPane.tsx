import { IS_WINDOWS } from "@/lib/platform";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  isWindowPresentationDocumentVisible,
  isWindowPresentationCovered,
  subscribeWindowPresentation,
} from "@/lib/windowPresentation";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useBrowserAutomationActivity } from "./automationActivity";
import {
  BrowserAddressBar,
  type BrowserAddressBarHandle,
} from "./BrowserAddressBar";
import { BrowserStartPage } from "./BrowserStartPage";
import { recordBrowserVisit } from "./history";
import {
  BROWSER_NAV_EVENT,
  BROWSER_LOADING_FALLBACK_MS,
  type BrowserNavEvent,
  browserEmbedDispatch,
  browserEmbedInsertText,
  browserEmbedNavigate,
  browserEmbedRelease,
  browserEmbedSetPunchHole,
  browserEmbedSetUiOverlay,
  browserEmbedSetZoom,
  browserEmbedSnapshot,
  browserEmbedUpdate,
  browserEmbedUrl,
  browserPresentationBounds,
  browserUrlError,
  canMeasureBrowserPane,
  createBrowserOwnerId,
  forgetBrowserOwnerId,
  isReportableBrowserNavUrl,
  isSelfReferenceUrl,
  isSupportedBrowserUrl,
  type PunchHole,
  shouldShowBrowserPane,
  toPhysicalBounds,
} from "./native";
import {
  notifyNativeBrowserLayout,
  subscribeNativeBrowserLayout,
  useNativeBrowserDragActive,
  useNativeBrowserOverlayOpen,
} from "./nativeVisibility";

export type BrowserPaneHandle = {
  reload: () => void;
  navigate: (url: string) => void;
  focusAddressBar: () => void;
  getUrl: () => string;
  insertText: (text: string) => Promise<boolean>;
};

type Props = {
  id: number;
  url: string;
  visible: boolean;
  workspaceRoot: string | null;
  workspace: WorkspaceEnv;
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
const visibleNativeBrowserOwners = new Map<number, number>();
const lastVisibleBrowserBounds = new Map<number, DesiredBounds["bounds"]>();

function syncNativeBrowserSurface(): void {
  if (visibleNativeBrowserOwners.size > 0) {
    document.documentElement.dataset.nativeBrowserLive = "true";
  } else {
    delete document.documentElement.dataset.nativeBrowserLive;
  }
}

function acquireNativeBrowserSurface(id: number): void {
  visibleNativeBrowserOwners.set(
    id,
    (visibleNativeBrowserOwners.get(id) ?? 0) + 1,
  );
  syncNativeBrowserSurface();
}

function releaseNativeBrowserSurface(id: number): void {
  const remaining = (visibleNativeBrowserOwners.get(id) ?? 1) - 1;
  if (remaining > 0) {
    visibleNativeBrowserOwners.set(id, remaining);
  } else {
    visibleNativeBrowserOwners.delete(id);
  }
  syncNativeBrowserSurface();
}

export const BrowserPane = forwardRef<BrowserPaneHandle, Props>(
  function BrowserPane(
    {
      id,
      url,
      visible,
      workspaceRoot,
      workspace,
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
    const workspaceContextRef = useRef({ root: workspaceRoot, workspace });
    const urlPropRef = useRef(url);
    const onUrlChangeRef = useRef(onUrlChange);
    const onTitleChangeRef = useRef(onTitleChange);
    const visibleRef = useRef(visible);
    const overlayOpen = useNativeBrowserOverlayOpen(
      contentRef,
      native && IS_WINDOWS && visible && !!url,
    );
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
    const urlError = browserUrlError(url);

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
    workspaceContextRef.current = { root: workspaceRoot, workspace };

    // Propagate the per-tab loading flag up to the tab store (tab spinner).
    useEffect(() => {
      onLoadingChangeRef.current?.(loading);
    }, [loading]);

    // Keep a bounded fallback for a renderer that never reports completion.
    // Normal loading state follows the native Started/Finished lifecycle.
    useEffect(() => {
      if (!loading) return;
      const timer = setTimeout(
        () => setLoading(false),
        BROWSER_LOADING_FALLBACK_MS,
      );
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
        workspaceContextRef.current,
      )
        .then(() => {
          if (disposedRef.current) return;
          if (IS_WINDOWS && desired.visible) {
            // Restoring the native paint region also resets any AI mini-window
            // punch hole. Recompute it only after the visible bounds update has
            // completed so the final region cannot be overwritten by a race.
            lastHoleRef.current = "";
            notifyNativeBrowserLayout();
          }
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

    useLayoutEffect(() => {
      if (!native || !IS_WINDOWS || !visible || !url || urlError) return;
      acquireNativeBrowserSurface(id);
      return () => {
        releaseNativeBrowserSurface(id);
      };
    }, [id, native, url, urlError, visible]);

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
        isWindowPresentationDocumentVisible(
          document.visibilityState === "visible",
        ) && !isWindowPresentationCovered(),
        allowedUrl,
        !!element,
      );
      const rect =
        canMeasure && element ? element.getBoundingClientRect() : null;
      const hasArea = !!rect && rect.width >= 1 && rect.height >= 1;
      const dpr = window.devicePixelRatio || 1;
      const measuredBounds = hasArea
        ? toPhysicalBounds(rect, dpr)
        : EMPTY_BOUNDS;
      const bounds = browserPresentationBounds(
        visibleRef.current,
        measuredBounds,
        lastVisibleBrowserBounds.get(id) ?? null,
      );
      const shouldShow = shouldShowBrowserPane(
        canMeasure,
        visibleRef.current,
        hasArea,
        suppressionReadyRef.current,
      );
      if (shouldShow) lastVisibleBrowserBounds.set(id, bounds);
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

      // Keep persistent floating surfaces interactive without sinking the
      // complete native browser behind the main webview.
      if (IS_WINDOWS && shouldShow) {
        const surfaces = document.querySelectorAll<HTMLElement>(
          '[data-ai-mini-window][data-state="open"], [data-anbo-voice-overlay]',
        );
        const holes: PunchHole[] = [];
        if (rect) {
          for (const surface of surfaces) {
            const floating = surface.getBoundingClientRect();
            const ix = Math.max(rect.left, floating.left);
            const iy = Math.max(rect.top, floating.top);
            const ir = Math.min(rect.right, floating.right);
            const ib = Math.min(rect.bottom, floating.bottom);
            if (ir <= ix || ib <= iy) continue;
            if (holes.length >= 8) break;
            holes.push({
              x: Math.round((ix - rect.left) * dpr),
              y: Math.round((iy - rect.top) * dpr),
              width: Math.round((ir - ix) * dpr),
              height: Math.round((ib - iy) * dpr),
            });
          }
        }
        const key = holes.length
          ? holes
              .map((hole) => `${hole.x},${hole.y},${hole.width},${hole.height}`)
              .join(";")
          : "none";
        if (key !== lastHoleRef.current) {
          lastHoleRef.current = key;
          void browserEmbedSetPunchHole(id, ownerIdRef.current, holes).catch(
            () => {},
          );
        }
      }
    }, [id, native, sendDesiredBounds]);

    useLayoutEffect(() => {
      if (!native) return;
      syncBounds();
      if (!visible) {
        return;
      }
      let frame = 0;
      const scheduleBounds = () => {
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            syncBounds();
          });
        }
      };
      const element = contentRef.current;
      const resizeObserver = new ResizeObserver(scheduleBounds);
      if (element) resizeObserver.observe(element);
      const unsubscribeLayout = subscribeNativeBrowserLayout(scheduleBounds);
      // Minimize can suspend animation frames before a queued layout callback
      // runs. Apply presentation transitions immediately so the native child
      // surface is parked before Windows starts composing the restore frame.
      const unsubscribePresentation = subscribeWindowPresentation((next) => {
        if (next === "ready") sentKeyRef.current = "";
        syncBounds();
      });
      return () => {
        resizeObserver.disconnect();
        unsubscribeLayout();
        unsubscribePresentation();
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      };
    }, [native, syncBounds, visible]);

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
          lastVisibleBrowserBounds.delete(id);
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
        setFreezeFrame(null);
        suppressionReadyRef.current = false;
        sentKeyRef.current = "";
        syncBounds();
        return;
      }
      if (!visible || !currentUrlRef.current) {
        setFreezeFrame(null);
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
    }, [dragActive, id, native, syncBounds, visible]);

    useEffect(() => {
      if (!native) return;
      let alive = true;
      let unlisten: UnlistenFn | undefined;
      void listen<BrowserNavEvent>(BROWSER_NAV_EVENT, ({ payload }) => {
        if (
          !payload ||
          payload.tabId !== id ||
          payload.ownerId !== ownerIdRef.current ||
          !isReportableBrowserNavUrl(payload.url)
        )
          return;
        if (payload.kind === "navigated") {
          setLoading(true);
        } else if (payload.kind === "loaded") {
          setLoading(false);
          recordBrowserVisit(payload.url);
          return;
        }
        if (payload.kind === "title" && payload.title?.trim()) {
          const title = payload.title.trim().slice(0, 200);
          onTitleChangeRef.current(title);
          recordBrowserVisit(payload.url, title);
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
      if (urlError) {
        boundsErrorRef.current = false;
        return;
      }
      setNativeError(null);
      if (url === currentUrlRef.current) return;
      currentUrlRef.current = url;
      setLoading(true);
      void browserEmbedNavigate(
        id,
        ownerIdRef.current,
        url,
        workspaceContextRef.current,
      ).catch(reportNativeError);
    }, [id, native, reportNativeError, url, urlError]);

    const navigate = useCallback(
      (next: string) => {
        currentUrlRef.current = next;
        onUrlChangeRef.current(next);
        setNativeError(null);
        if (native) {
          const validationError = browserUrlError(next);
          if (validationError) {
            boundsErrorRef.current = false;
            setNativeError(validationError);
          } else {
            setLoading(true);
            void browserEmbedNavigate(
              id,
              ownerIdRef.current,
              next,
              workspaceContextRef.current,
            ).catch(reportNativeError);
          }
          syncBounds();
        } else {
          recordBrowserVisit(next);
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
        insertText: (text: string) =>
          browserEmbedInsertText(id, ownerIdRef.current, text),
      }),
      [dispatch, id, navigate],
    );

    const showXfoHint = !native && url ? !isLocalUrl(url) : false;
    const browserError = urlError ?? nativeError;

    return (
      <div
        className={`flex h-full w-full flex-col overflow-hidden ${native && url && !browserError ? "bg-transparent" : "bg-background"}`}
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
                ? browserError || loading
                  ? "relative min-h-0 flex-1 bg-background"
                  : "relative min-h-0 flex-1 bg-transparent"
                : "relative min-h-0 flex-1 bg-white"
              : "relative min-h-0 flex-1 bg-background"
          }
        >
          {native && visible && dragActive && freezeFrame && !browserError ? (
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
              browserError ? (
                <BrowserError message={browserError} />
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
            <BrowserStartPage visible={visible} onNavigate={navigate} />
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
