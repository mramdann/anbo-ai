import { useBrowserDock } from "@/modules/browser/external/docking";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BrowserAddressBar,
  type BrowserAddressBarHandle,
} from "@/modules/browser/BrowserAddressBar";
import type { BrowserPaneHandle } from "@/modules/browser/BrowserPane";
import {
  setAutomationEffectsEnabled,
  useAutomationEffectsEnabled,
} from "@/modules/browser/automationState";
import { devicePreset } from "@/modules/browser/devices";
import {
  applyBrowserDesignStatus,
  useBrowserDesign,
} from "@/modules/browser/design/designState";
import { readDesignTheme } from "@/modules/browser/design/designTheme";
import { browserDesignSet } from "@/modules/browser/native";
import type { BrowserTab } from "@/modules/tabs";
import { invoke } from "@tauri-apps/api/core";
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const Connections = lazy(
  () => import("@/modules/browser/external/ExternalBrowserConnections"),
);
const DesignToolbar = lazy(
  () => import("@/modules/browser/design/DesignToolbar"),
);
const DesignSendDialog = lazy(
  () => import("@/modules/browser/design/DesignSendDialog"),
);

export default forwardRef<
  BrowserPaneHandle,
  { tab: BrowserTab; visible: boolean; workspaceRoot: string | null }
>(function ExternalBrowserPane({ tab, visible, workspaceRoot }, ref) {
  const external = tab.external;
  const dock = useBrowserDock(tab, visible);
  const address = useRef<BrowserAddressBarHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const effects = useAutomationEffectsEnabled();
  const [device, setDevice] = useState("responsive");
  const [sendDesign, setSendDesign] = useState(false);
  const design = useBrowserDesign(tab.id);
  const sequence = useRef(0);
  const lastPage = useRef("");
  const pageIdentity = `${tab.url}\n${external?.selectionId ?? ""}`;
  const browser = external?.browser === "edge" ? "Edge" : "Chrome";

  useEffect(() => {
    if (!visible || lastPage.current !== pageIdentity) {
      sequence.current += 1;
      setPreview(null);
    }
    lastPage.current = pageIdentity;
    if (!visible) {
      setManage(false);
      setSendDesign(false);
    }
  }, [visible, pageIdentity]);

  useEffect(() => {
    if (!external?.connected) return;
    void invoke("browser_external_control", {
      tabId: tab.id,
      connectionId: external.connectionId,
      selectionId: external.selectionId,
      control: { action: "effects", enabled: effects },
    }).catch((cause) => setError(String(cause)));
  }, [
    external?.connected,
    external?.connectionId,
    external?.selectionId,
    tab.id,
    effects,
  ]);

  const run = useCallback(
    async (control: Record<string, unknown>) => {
      setError(null);
      try {
        if (!external?.connected)
          throw new Error(
            "Reconnect this profile and select the tab in Browser connections.",
          );
        return await invoke<{ data?: string; inserted?: boolean }>(
          "browser_external_control",
          {
            tabId: tab.id,
            connectionId: external.connectionId,
            selectionId: external.selectionId,
            control,
          },
        );
      } catch (cause) {
        setError(String(cause));
        return undefined;
      }
    },
    [
      tab.id,
      external?.connected,
      external?.connectionId,
      external?.selectionId,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({
      reload: () => {
        void run({ action: "reload" });
      },
      navigate: (url) => {
        void run({ action: "navigate", url });
      },
      focusAddressBar: () => address.current?.focus(),
      getUrl: () => tab.url,
      insertText: async (text) =>
        (await run({ action: "insertText", text }))?.inserted === true,
    }),
    [run, tab.url],
  );

  const capture = async () => {
    const request = ++sequence.current;
    setBusy(true);
    const result = await run({ action: "capture" });
    if (
      request === sequence.current &&
      result?.data &&
      result.data.length <= 24 * 1024 * 1024
    )
      setPreview(`data:image/png;base64,${result.data}`);
    setBusy(false);
  };

  const toggleDesign = async () => {
    try {
      const active = !design.active;
      const theme = active
        ? readDesignTheme(
            document.documentElement.classList.contains("dark")
              ? "dark"
              : "light",
          )
        : undefined;
      applyBrowserDesignStatus(await browserDesignSet(tab.id, active, theme));
      if (active) await run({ action: "focus" });
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <BrowserAddressBar
        ref={address}
        url={tab.url}
        onSubmit={(url) => {
          void run({ action: "navigate", url });
        }}
        onBack={() => {
          void run({ action: "back" });
        }}
        onForward={() => {
          void run({ action: "forward" });
        }}
        onReload={() => {
          void run({ action: "reload" });
        }}
        deviceId={device}
        onDevice={(id) => {
          const preset = devicePreset(id);
          void run({
            action: "viewport",
            width: preset.width,
            height: preset.height,
            scale: preset.scale,
            mobile: preset.mobile,
          }).then((result) => {
            if (result) setDevice(id);
          });
        }}
        effectsEnabled={effects}
        onToggleEffects={() => setAutomationEffectsEnabled(!effects)}
        designActive={design.active}
        onToggleDesign={
          external?.connected && !dock.dockId
            ? () => {
                void toggleDesign();
              }
            : undefined
        }
      />
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-xs">
        <Button
          size="sm"
          variant="outline"
          disabled={!external?.connected || dock.busy || design.active}
          onClick={() => void dock.toggle()}
        >
          {dock.busy
            ? "Preparing..."
            : dock.dockId
              ? "Release to browser"
              : "Dock in this panel (preview)"}
        </Button>
        <span className="text-muted-foreground">
          {dock.dockId
            ? "Native window, no streaming. Prototype: cursor/design overlays are not enabled."
            : "One docked tab at a time. Requires browser extension 0.4.2 or newer."}
        </span>
      </div>
      {dock.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {dock.error}
        </p>
      ) : null}
      {design.active ? (
        <Suspense fallback={null}>
          <DesignToolbar
            tabId={tab.id}
            status={design}
            onSend={() => setSendDesign(true)}
            onExit={() => {
              void toggleDesign();
            }}
          />
        </Suspense>
      ) : null}
      {sendDesign ? (
        <Suspense fallback={null}>
          <DesignSendDialog
            open={sendDesign}
            onOpenChange={setSendDesign}
            tabId={tab.id}
            workspaceRoot={workspaceRoot}
            status={design}
            preferredAgent={null}
          />
        </Suspense>
      ) : null}
      <div
        ref={dock.surface}
        className="relative flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto p-6"
      >
        {dock.dockId ? (
          <p className="text-sm text-muted-foreground">
            The real browser occupies this panel while Anbo is active. Minimum
            panel size: 400 by 300 physical pixels.
          </p>
        ) : (
          <>
            <div className="w-full max-w-2xl rounded-xl border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>
                  {browser} / {external?.name}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {external?.connected ? "Connected" : "Disconnected"}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                The live page and your login stay in the original {browser}{" "}
                window. Agents control this tab through Anbo, including when you
                switch workspaces.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Mouse effects and design annotations appear on the real page.
                Previews below are manual snapshots, not a live video or an
                interactive page.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Closing this Anbo tab releases a tab you selected. Tabs opened
                by Anbo are also closed in the browser.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  disabled={!external?.connected}
                  onClick={() => {
                    void run({ action: "focus" });
                  }}
                >
                  Show in {browser}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !external?.connected}
                  onClick={() => {
                    void capture();
                  }}
                >
                  {busy ? "Capturing..." : "Preview page"}
                </Button>
                <Button variant="ghost" onClick={() => setManage(true)}>
                  Browser connections
                </Button>
              </div>
              {error || external?.error ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error ?? external?.error}
                </p>
              ) : null}
              {!external?.connected ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Reconnect the same profile and select the tab again. Anbo
                  never opens this saved URL in another profile automatically.
                </p>
              ) : null}
            </div>
            {preview ? (
              <div className="w-full max-w-5xl">
                <p className="mb-2 text-xs text-muted-foreground">
                  Snapshot. Click Preview page to update.
                </p>
                <img
                  src={preview}
                  alt={`Snapshot of ${tab.title}`}
                  className="w-full rounded-lg border"
                />
              </div>
            ) : null}
          </>
        )}
      </div>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chrome / Edge connections</DialogTitle>
            <DialogDescription>
              Connect a profile without copying its login data.
            </DialogDescription>
          </DialogHeader>
          <Suspense fallback={<p>Loading connections...</p>}>
            <Connections workspaceRoot={workspaceRoot} />
          </Suspense>
        </DialogContent>
      </Dialog>
    </div>
  );
});
