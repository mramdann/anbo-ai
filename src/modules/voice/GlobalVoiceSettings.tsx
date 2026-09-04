import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setGlobalVoiceEnabled } from "@/modules/settings/store";
import {
  type GlobalVoiceStatus,
  getGlobalVoiceStatus,
} from "@/modules/voice/lib/globalVoice";
import { useEffect, useState } from "react";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GlobalVoiceSettings() {
  const enabled = usePreferencesStore((state) => state.globalVoiceEnabled);
  const [status, setStatus] = useState<GlobalVoiceStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getGlobalVoiceStatus().then(
      (next) => {
        if (alive) setStatus(next);
      },
      (cause) => {
        if (alive) setError(errorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const update = async (checked: boolean) => {
    setUpdating(true);
    setError(null);
    try {
      await setGlobalVoiceEnabled(checked);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/35 p-2.5">
      <div className="min-w-0">
        <div className="text-[10.5px] font-medium">Use across Windows</div>
        <div className="mt-0.5 text-[9.5px] leading-relaxed text-muted-foreground">
          A movable AnboVoice orb types into the focused app. Toggle recording
          with {status?.shortcut ?? "Ctrl+Alt+Space"}.
        </div>
        {status?.supported === false ? (
          <div className="mt-1 text-[9.5px] text-muted-foreground">
            Currently available on Windows only.
          </div>
        ) : null}
        {error ? (
          <div className="mt-1 text-[9.5px] text-destructive">{error}</div>
        ) : null}
      </div>
      <Switch
        size="sm"
        checked={enabled}
        disabled={updating || status?.supported === false}
        onCheckedChange={(checked) => void update(checked)}
        aria-label="Use AnboVoice across Windows"
      />
    </div>
  );
}
