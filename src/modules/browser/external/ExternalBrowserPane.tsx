import { Button } from "@/components/ui/button";
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
import { useBrowserDock } from "@/modules/browser/external/docking";
import {
  browserName,
  useExternalBrowsers,
} from "@/modules/browser/external/store";
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

const DesignToolbar = lazy(
  () => import("@/modules/browser/design/DesignToolbar"),
);
const DesignSendDialog = lazy(
  () => import("@/modules/browser/design/DesignSendDialog"),
);

export function dockNotice(reason: string | null, browser: string): string {
  switch (reason) {
    case "panel-too-narrow":
      return `Make this panel wider to show the page. ${browser} does not allow a narrower window.`;
    case "panel-outside-host":
      return "Move this panel back inside the Anbo window to show the page.";
    case "browser-fullscreen":
      return `The page is full screen in ${browser}. Leave full screen to bring it back here.`;
  }
  return `Opening the page from ${browser}...`;
}

export default forwardRef<
  BrowserPaneHandle,
  { tab: BrowserTab; visible: boolean; workspaceRoot: string | null }
>(function ExternalBrowserPane({ tab, visible, workspaceRoot }, ref) {
  const external = tab.external;
  const dock = useBrowserDock(tab, visible);
  const address = useRef<BrowserAddressBarHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const effects = useAutomationEffectsEnabled();
  const [device, setDevice] = useState("responsive");
  const [sendDesign, setSendDesign] = useState(false);
  const design = useBrowserDesign(tab.id);
  const browser = browserName(external?.browser ?? "chrome");

  useEffect(() => {
    if (!visible) setSendDesign(false);
  }, [visible]);

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
            `Reconnect ${browser} from the browser menu at the top of Anbo.`,
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
      browser,
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

  const problem = dock.error ?? error ?? external?.error ?? null;
  return (
    <div
      className={`flex h-full flex-col ${dock.live ? "bg-transparent" : "bg-background"}`}
    >
      <div className="shrink-0 bg-background">
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
            external?.connected
              ? () => {
                  void toggleDesign();
                }
              : undefined
          }
        />
        {problem && external?.connected ? (
          <div
            role="alert"
            className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 break-words">{problem}</span>
            {dock.hold === "failed" ? (
              <Button size="xs" variant="outline" onClick={dock.retry}>
                Try again
              </Button>
            ) : null}
          </div>
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
      </div>
      <div
        ref={dock.surface}
        className={
          dock.live
            ? "relative min-h-0 flex-1"
            : "relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-background p-6 text-center"
        }
      >
        {dock.live ? null : !external?.connected ? (
          <Disconnected
            browser={browser}
            name={external?.name ?? ""}
            error={external?.error ?? null}
          />
        ) : dock.hold === "moved" ? (
          <>
            <p className="text-sm text-muted-foreground">
              The page went back to {browser}.
            </p>
            <Button size="sm" variant="outline" onClick={dock.retry}>
              Show it here
            </Button>
          </>
        ) : dock.hold === "failed" ? (
          <p className="text-sm text-muted-foreground">
            The page could not be shown here.
          </p>
        ) : dock.waiting ? (
          // A click brings Anbo to the front, which is all the dock waits for.
          <Button size="sm" variant="outline" onClick={dock.retry}>
            Show the page
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {dockNotice(dock.reason, browser)}
          </p>
        )}
      </div>
    </div>
  );
});

function Disconnected({
  browser,
  name,
  error,
}: {
  browser: string;
  name: string;
  error: string | null;
}) {
  const openMenu = useExternalBrowsers((state) => state.setMenuOpen);
  return (
    <div className="grid max-w-sm justify-items-center gap-2">
      <p className="text-sm font-medium text-foreground">
        {browser}
        {name ? ` · ${name}` : ""} is not connected
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {error ??
          `Connect it from the ${browser} extension, then approve it in the browser menu at the top of Anbo. This tab comes back when the page is chosen again.`}
      </p>
      <Button size="sm" variant="outline" onClick={() => openMenu(true)}>
        Open browser menu
      </Button>
    </div>
  );
}
