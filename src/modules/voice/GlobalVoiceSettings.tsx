import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setGlobalVoiceEnabled,
  setGlobalVoicePushToTalk,
} from "@/modules/settings/store";
import {
  type GlobalVoiceStatus,
  getGlobalVoiceStatus,
  isPushToTalkKey,
  PUSH_TO_TALK_KEYS,
  type PushToTalkKey,
} from "@/modules/voice/lib/globalVoice";
import { useEffect, useState } from "react";

const PUSH_TO_TALK_LABELS: Record<PushToTalkKey, string> = {
  win: "Hold Win",
  ctrl_win: "Hold Ctrl+Win",
  right_alt: "Hold Right Alt",
  off: "Off",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GlobalVoiceSettings() {
  const enabled = usePreferencesStore((state) => state.globalVoiceEnabled);
  const pushToTalk = usePreferencesStore(
    (state) => state.globalVoicePushToTalk,
  );
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
    <div className="rounded-lg border border-border/60 bg-background/35 p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10.5px] font-medium">Use across Windows</div>
          <div className="mt-0.5 text-[9.5px] leading-relaxed text-muted-foreground">
            A movable AnboVoice orb types into the focused app. Hold the key
            below to talk and release it to type, or toggle hands-free recording
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
          disabled={updating || status === null || !status.supported}
          onCheckedChange={(checked) => void update(checked)}
          aria-label="Use AnboVoice across Windows"
        />
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">
          Hold to talk
        </span>
        <Select
          value={pushToTalk}
          onValueChange={(value) => {
            if (isPushToTalkKey(value)) void setGlobalVoicePushToTalk(value);
          }}
          disabled={status?.supported === false}
        >
          <SelectTrigger size="sm" className="h-7 min-w-44 flex-1 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PUSH_TO_TALK_KEYS.map((key) => (
              <SelectItem key={key} value={key} className="text-[11px]">
                {PUSH_TO_TALK_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
