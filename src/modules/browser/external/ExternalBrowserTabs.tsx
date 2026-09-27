import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type ExternalTab = { id: number; title: string; url: string };

export function ExternalBrowserTabs({
  connectionId,
  selected,
  disabled,
  onChanged,
}: {
  connectionId: string;
  selected: ExternalTab[];
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [available, setAvailable] = useState<ExternalTab[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const tabs = await invoke<ExternalTab[]>("browser_external_list_tabs", {
        connectionId,
      });
      if (sequence.current === request) {
        setAvailable(tabs);
        setError(null);
      }
    } catch (cause) {
      if (sequence.current === request) setError(String(cause));
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const locked = busy || disabled;
  const candidates = available.filter(
    (tab) => !selected.some((chosen) => chosen.id === tab.id),
  );
  return (
    <div className="grid gap-2 border-t pt-2">
      <p className="text-muted-foreground">
        Choose a tab here or open a URL. Only those tabs connect to Anbo; no
        Share button in the extension.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || !url.trim()) return;
          void perform(async () => {
            await invoke("browser_external_open_tab", {
              connectionId,
              url: url.trim(),
            });
            setUrl("");
          });
        }}
      >
        <Input
          aria-label="URL to open in this browser profile"
          type="url"
          placeholder="https://example.com"
          value={url}
          disabled={locked}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={locked || !url.trim()}>
          Open tab
        </Button>
      </form>
      <div className="flex items-center justify-between gap-2">
        <strong>Available tabs</strong>
        <Button
          variant="ghost"
          size="sm"
          disabled={locked || loading}
          onClick={() => void refresh()}
        >
          {loading ? "Loading tabs..." : "Refresh tabs"}
        </Button>
      </div>
      <div className="grid max-h-48 gap-2 overflow-y-auto">
        {candidates.map((tab) => (
          <div key={tab.id} className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate">{tab.title || "Untitled tab"}</p>
              <p className="truncate text-muted-foreground">{tab.url}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() =>
                void perform(() =>
                  invoke("browser_external_select_tab", {
                    connectionId,
                    tabId: tab.id,
                    expectedUrl: tab.url,
                  }),
                )
              }
            >
              Use in Anbo
            </Button>
          </div>
        ))}
        {!loading && candidates.length === 0 ? (
          <p className="text-muted-foreground">
            No other HTTP(S) tabs. Open a URL here or refresh the list.
          </p>
        ) : null}
      </div>
      {busy ? <p role="status">Connecting the selected tab...</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
