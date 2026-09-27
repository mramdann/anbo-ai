import { Button } from "@/components/ui/button";
import { ExternalBrowserTabs } from "@/modules/browser/external/ExternalBrowserTabs";
import {
  BrowserSetupInstructions,
  type BrowserSetupResult,
} from "@/modules/browser/external/BrowserSetupInstructions";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

type Connection = {
  connectionId: string;
  profile: { profileId: string; browser: "chrome" | "edge"; name: string };
  workspace: string | null;
  tabs: { id: number; title: string; url: string }[];
};

export default function ExternalBrowserConnections({
  workspaceRoot,
}: {
  workspaceRoot: string | null;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<string | null>(null);
  const [setup, setSetup] = useState<BrowserSetupResult | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await invoke<Connection[]>("browser_external_connections");
      if (request === sequence.current) {
        setConnections(next);
        setError(null);
      }
    } catch (cause) {
      if (request === sequence.current) setError(String(cause));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const listener = listen("anbo:external-browser-changed", () => {
      if (!cancelled) void refresh();
    });
    void listener.then(
      () => {
        if (!cancelled) void refresh();
      },
      (cause) => {
        if (!cancelled) setError(String(cause));
      },
    );
    return () => {
      cancelled = true;
      sequence.current += 1;
      void listener.then(
        (unlisten) => unlisten(),
        () => {},
      );
    };
  }, [refresh]);

  const act = async (command: string, args?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<unknown>(command, args);
      if (command === "browser_external_inspect")
        setInspection(JSON.stringify(result, null, 2));
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const install = async (browser: "chrome" | "edge") => {
    setBusy(true);
    setSettingUp(true);
    setError(null);
    setCopied(false);
    setSetup(null);
    try {
      setSetup(
        await invoke<BrowserSetupResult>("browser_external_setup", { browser }),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSettingUp(false);
      setBusy(false);
    }
  };

  const copyFolder = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.extensionPath);
      setCopied(true);
    } catch {
      setError(
        "Could not copy the folder path. Select and copy the path shown above.",
      );
    }
  };

  return (
    <div className="grid gap-3 text-xs">
      <p className="break-all text-muted-foreground">
        Approval workspace: {workspaceRoot ?? "Select a workspace first"}
      </p>
      <p className="text-muted-foreground">
        Selected tabs appear in Anbo. Pages, login sessions, mouse effects and
        design annotations stay in the original Chrome/Edge window. Browser
        automation continues when you switch Anbo workspaces.
      </p>
      <p className="text-muted-foreground">
        Setup installs the bridge for this Anbo instance and opens your
        browser's extensions page. No terminal commands, admin access, or
        login-data copying. Chrome/Edge still requires you to allow the
        development extension once per profile.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void install("chrome")}
        >
          Setup Chrome
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void install("edge")}
        >
          Setup Edge
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      {settingUp ? (
        <p role="status" className="text-muted-foreground">
          Installing the bridge for this Windows user. This may take a moment.
        </p>
      ) : null}
      {setup ? (
        <BrowserSetupInstructions
          setup={setup}
          copied={copied}
          onCopy={() => void copyFolder()}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {connections.length === 0 ? (
        <p className="text-muted-foreground">No connected profiles.</p>
      ) : null}
      {connections.map((connection) => (
        <section
          key={connection.connectionId}
          className="grid gap-2 rounded-lg border p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <strong className="truncate">
              {connection.profile.browser === "edge" ? "Edge" : "Chrome"} /{" "}
              {connection.profile.name}
            </strong>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act("browser_external_disconnect", {
                  connectionId: connection.connectionId,
                })
              }
            >
              Disconnect
            </Button>
          </div>
          <p className="break-all text-muted-foreground">
            Profile ID: {connection.profile.profileId}
          </p>
          {connection.workspace ? (
            <p className="break-all text-muted-foreground">
              Workspace: {connection.workspace}
            </p>
          ) : (
            <div className="grid gap-2">
              <p className="text-muted-foreground">
                Allow Anbo to list this profile's regular tab titles and URLs.
                Only tabs you choose or open in Anbo are connected for control.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !workspaceRoot}
                onClick={() =>
                  void act("browser_external_approve", {
                    connectionId: connection.connectionId,
                    workspace: workspaceRoot,
                  })
                }
              >
                Approve for this workspace
              </Button>
            </div>
          )}
          {connection.workspace ? (
            <ExternalBrowserTabs
              connectionId={connection.connectionId}
              selected={connection.tabs}
              disabled={busy}
              onChanged={refresh}
            />
          ) : null}
          {connection.tabs.length > 0 ? <strong>Connected tabs</strong> : null}
          {connection.tabs.map((tab) => (
            <div key={tab.id} className="grid gap-1 border-t pt-2">
              <span className="truncate">{tab.title || "Untitled tab"}</span>
              <span className="truncate text-muted-foreground">{tab.url}</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act("browser_external_focus", {
                      connectionId: connection.connectionId,
                      tabId: tab.id,
                    })
                  }
                >
                  Show in browser
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act("browser_external_inspect", {
                      connectionId: connection.connectionId,
                      tabId: tab.id,
                    })
                  }
                >
                  Check connection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act("browser_external_release_tab", {
                      connectionId: connection.connectionId,
                      tabId: tab.id,
                    })
                  }
                >
                  Release tab
                </Button>
              </div>
            </div>
          ))}
        </section>
      ))}
      {inspection ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border p-2 text-[11px]">
          {inspection}
        </pre>
      ) : null}
    </div>
  );
}
