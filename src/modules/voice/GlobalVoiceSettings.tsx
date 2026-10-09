import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  isVoiceLiveSource,
  STT_PROVIDER_LABELS,
  type SttProvider,
  type VoiceLiveSource,
} from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setGlobalVoiceEnabled,
  setGlobalVoicePushToTalk,
  setVoiceLiveSource,
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

function liveLabel(source: VoiceLiveSource, provider: SttProvider): string {
  if (source === "local") return "Local Whisper";
  if (source === "provider") return STT_PROVIDER_LABELS[provider];
  return "Off";
}

function liveNote(source: VoiceLiveSource, provider: SttProvider) {
  if (source === "off") return null;
  if (provider === "whispercpp") {
    return "Words show beside the orb while you speak.";
  }
  if (source === "local") {
    return `Words show beside the orb while you speak, read by the local runtime below; the typed text still comes from ${STT_PROVIDER_LABELS[provider]}.`;
  }
  if (provider === "groq") {
    return "Every update is a Groq request. Live text keeps to 12 a minute, so the typed text always has room on the free plan.";
  }
  return "Every update is a paid OpenAI request.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GlobalVoiceSettings() {
  const enabled = usePreferencesStore((state) => state.globalVoiceEnabled);
  const pushToTalk = usePreferencesStore(
    (state) => state.globalVoicePushToTalk,
  );
  const provider = usePreferencesStore((state) => state.sttProvider);
  const storedLive = usePreferencesStore((state) => state.voiceLiveSource);
  // With the local provider there is one service to read live text from.
  const liveChoices: VoiceLiveSource[] =
    provider === "whispercpp" ? ["local", "off"] : ["local", "provider", "off"];
  const liveSource =
    provider === "whispercpp" && storedLive === "provider"
      ? "local"
      : storedLive;
  const note = liveNote(liveSource, provider);
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
      <div className="mt-2 flex items-center gap-2">
        <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">
          Live text
        </span>
        <Select
          value={liveSource}
          onValueChange={(value) => {
            if (isVoiceLiveSource(value)) void setVoiceLiveSource(value);
          }}
          disabled={status?.supported === false}
        >
          <SelectTrigger size="sm" className="h-7 min-w-44 flex-1 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {liveChoices.map((source) => (
              <SelectItem key={source} value={source} className="text-[11px]">
                {liveLabel(source, provider)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {note ? (
        <p className="ml-18 mt-1 text-[9.5px] leading-relaxed text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}
