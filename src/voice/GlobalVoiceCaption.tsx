import { cn } from "@/lib/utils";
import {
  GLOBAL_VOICE_CAPTION_EVENT,
  type GlobalVoiceCaption as Caption,
  readGlobalVoiceCaption,
} from "@/modules/voice/lib/globalVoice";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** The words heard so far in a take, shown beside the orb until the final
 * text is typed. The window ignores the pointer, so this is display only. */
export function GlobalVoiceCaption() {
  const [caption, setCaption] = useState<Caption | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // The first read and an event can arrive in either order.
    const apply = (next: Caption) =>
      setCaption((current) =>
        current && current.seq >= next.seq ? current : next,
      );
    void listen<Caption>(GLOBAL_VOICE_CAPTION_EVENT, ({ payload }) =>
      apply(payload),
    )
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        return readGlobalVoiceCaption().then(apply);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!caption?.text) return null;
  return (
    <div
      className={cn(
        "flex size-full p-1.5",
        caption.above ? "items-end" : "items-start",
        caption.alignRight ? "justify-end" : "justify-start",
      )}
    >
      <div className="max-w-full rounded-xl border border-primary/45 bg-popover/95 px-2.5 py-1.5 text-popover-foreground shadow-lg">
        {/* Three lines at most; the newest words stay in view and the
            oldest leave at the top. */}
        <p className="flex max-h-12 flex-col justify-end overflow-hidden text-xs leading-4">
          <span className="break-words">{caption.text}</span>
        </p>
      </div>
    </div>
  );
}
