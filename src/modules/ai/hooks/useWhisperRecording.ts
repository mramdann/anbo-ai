import { usePreferencesStore } from "@/modules/settings/preferences";
import { warn } from "@tauri-apps/plugin-log";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type SttProvider, WHISPERCPP_DEFAULT_BASE_URL } from "../config";
import { createAudioMeter } from "../lib/audioMeter";
import { groqQuota } from "../lib/groqQuota";
import { liveProvider, trimSilence } from "../lib/liveTranscript";
import { type PcmCapture, startPcmCapture } from "../lib/pcmCapture";
import {
  peakLevel,
  SILENCE_RMS,
  type SttOptions,
  transcribeAudio,
  whisperCppReachable,
} from "../lib/stt";
import { followTake } from "../lib/takeFollower";
import { encodeWav, WHISPER_SAMPLE_RATE } from "../lib/wav";
import { useChatStore } from "../store/chatStore";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];
const MAX_RECORDING_MS = 5 * 60_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

/// Every surface that records voice fails through here. The in-app orb and the
/// composer used to show only a toast, which left nothing to go on afterwards,
/// so each failure is written to the app log too; the transcript never is.
function logVoiceFailure(detail: string): void {
  void warn(`voice input failed: ${detail}`).catch(() => {});
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerNeedsKey(provider: SttProvider): boolean {
  return provider !== "whispercpp";
}

function getApiKeyForStt(
  apiKeys: import("../lib/keyring").ProviderKeys,
  provider: SttProvider,
): string | null {
  if (provider === "openai") return apiKeys.openai;
  if (provider === "groq") return apiKeys.groq;
  return null;
}

type State = "idle" | "requesting" | "recording" | "transcribing";

export function useWhisperRecording({
  onResult,
  onError,
  onSettled,
  skipSilence = false,
  live = false,
}: {
  onResult: (text: string) => void | Promise<void>;
  onError?: (message: string) => void;
  onSettled?: () => void;
  /** Drop a take with nothing above room noise instead of transcribing it:
   * Whisper writes words into silence ("Thank you."), and a hold to talk can
   * end without a word said. */
  skipSilence?: boolean;
  /** Transcribe the take while it records too, and hand the words heard so
   * far out as `liveText`. The voice settings choose the service. */
  live?: boolean;
}) {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const sttProvider = usePreferencesStore((s) => s.sttProvider);
  const groqSttModel = usePreferencesStore((s) => s.groqSttModel);
  const whispercppBaseURL = usePreferencesStore((s) => s.whispercppBaseURL);
  const sttLanguage = usePreferencesStore((s) => s.sttLanguage);
  const liveSource = usePreferencesStore((s) => s.voiceLiveSource);
  const [state, setState] = useState<State>("idle");
  const [liveText, setLiveText] = useState<string | null>(null);
  const audioMeter = useMemo(createAudioMeter, []);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  const resultRef = useRef(onResult);
  const errorRef = useRef(onError);
  const settledRef = useRef(onSettled);
  const skipSilenceRef = useRef(skipSilence);
  const liveRef = useRef(live);
  const sessionResultRef = useRef(onResult);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  resultRef.current = onResult;
  errorRef.current = onError;
  settledRef.current = onSettled;
  skipSilenceRef.current = skipSilence;
  liveRef.current = live;

  const needsKey = providerNeedsKey(sttProvider);
  const providerKey = needsKey ? getApiKeyForStt(apiKeys, sttProvider) : null;
  const hasKey = needsKey ? !!providerKey : true;

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const sttOptions = useMemo<SttOptions>(
    () => ({ groqSttModel, whispercppBaseURL, language: sttLanguage }),
    [groqSttModel, whispercppBaseURL, sttLanguage],
  );

  const teardownStream = useCallback(() => {
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    audioMeter.disconnect();
    captureRef.current?.stop();
    captureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;
  }, [audioMeter]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      rec.stop();
      return;
    }
    // An inactive recorder that is still referenced means a stop is already in
    // flight, so let onstop land the state rather than racing it to idle.
    if (rec) return;
    // Never drop the runaway watchdog for a stop that stopped nothing, and never
    // leave the caller stranded in "recording" with no recorder behind it.
    if (stateRef.current !== "recording") return;
    activeRef.current = false;
    teardownStream();
    if (mountedRef.current) setState("idle");
  }, [teardownStream]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    activeRef.current = false;
    cancelledRef.current = true;
    chunksRef.current = [];
    const rec = recRef.current;
    recRef.current = null;
    if (rec && rec.state !== "inactive") rec.stop();
    // The bumped generation makes onstop bail before its own reset, so cancel
    // has to land the state machine back on idle itself.
    teardownStream();
    if (mountedRef.current) setState("idle");
  }, [teardownStream]);

  const start = useCallback(
    async (
      resultHandler?: (text: string) => void,
      takeOptions: {
        /** Types one sentence of a hands-free take as soon as the user
         * pauses after it, false when it could not; the result then holds
         * only what was not typed. */
        onSentence?: (text: string) => Promise<boolean>;
      } = {},
    ) => {
      if (!supported || !hasKey || state !== "idle" || activeRef.current) {
        return false;
      }
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = true;
      if (sttProvider === "whispercpp") {
        const endpoint =
          whispercppBaseURL?.replace(/\/+$/, "") || WHISPERCPP_DEFAULT_BASE_URL;
        if (!(await whisperCppReachable(endpoint))) {
          activeRef.current = false;
          logVoiceFailure(`whispercpp: no server at ${endpoint}`);
          errorRef.current?.(
            `No local Whisper server at ${endpoint}. Start it in Settings, under Models.`,
          );
          settledRef.current?.();
          return false;
        }
      }
      const onSentence = takeOptions.onSentence;
      let follower: ReturnType<typeof followTake> | null = null;
      let followed: PcmCapture | null = null;
      // The take's own audio, tapped beside the recorder for live text and to
      // type a hands-free take sentence by sentence. Nothing in it can fail
      // the take: without it, the whole take is transcribed at its end.
      const follow = async (stream: MediaStream) => {
        const recording = () =>
          generationRef.current === generation &&
          recRef.current?.state === "recording";
        let liveFrom = liveRef.current
          ? liveProvider(liveSource, sttProvider)
          : null;
        if (liveFrom === "whispercpp" && sttProvider !== "whispercpp") {
          // The final text goes elsewhere, so nothing checked this server.
          const endpoint =
            whispercppBaseURL?.replace(/\/+$/, "") ||
            WHISPERCPP_DEFAULT_BASE_URL;
          if (!(await whisperCppReachable(endpoint))) liveFrom = null;
        }
        if (!liveFrom && !onSentence) return;
        let capture: PcmCapture;
        try {
          capture = await startPcmCapture(stream);
        } catch (e) {
          logVoiceFailure(
            `the take's audio could not be followed: ${errorText(e)}`,
          );
          return;
        }
        if (!recording()) {
          capture.stop();
          return;
        }
        captureRef.current = capture;
        followed = capture;
        const provider = liveFrom;
        follower = followTake({
          take: capture,
          recording,
          wanted: () =>
            generationRef.current === generation && !cancelledRef.current,
          live: provider
            ? {
                provider,
                transcribe: (wav, seconds) =>
                  transcribeAudio(wav, provider, apiKeys, {
                    ...sttOptions,
                    audioSeconds: seconds,
                    preview: true,
                  }),
                allowed: (seconds) =>
                  provider !== "groq" || groqQuota.liveAllowed(seconds),
              }
            : null,
          sentences: onSentence
            ? {
                transcribe: (wav, seconds) =>
                  transcribeAudio(wav, sttProvider, apiKeys, {
                    ...sttOptions,
                    audioSeconds: seconds,
                  }),
                type: onSentence,
              }
            : null,
          onLiveText: setLiveText,
          log: logVoiceFailure,
        });
      };
      /** What a hands-free take still holds after its last typed sentence. */
      const finishSentences = async (
        current: ReturnType<typeof followTake>,
        capture: PcmCapture,
      ) => {
        const rest = await current.rest();
        const end = capture.seconds();
        const from = trimSilence(capture, rest.from, end);
        let tail = "";
        if (end - from >= 0.3 && capture.peak(from) >= SILENCE_RMS) {
          const seconds = end - from;
          try {
            tail = await transcribeAudio(
              encodeWav(capture.slice(from, end), WHISPER_SAMPLE_RATE),
              sttProvider,
              apiKeys,
              { ...sttOptions, audioSeconds: seconds },
            );
          } catch (e) {
            // Sentences already transcribed still go out.
            if (rest.untyped.length === 0) throw e;
            logVoiceFailure(
              `${sttProvider}, the end of a hands-free take: ${errorText(e)}`,
            );
          }
        }
        return [...rest.untyped, tail.trim()].filter(Boolean).join(" ");
      };
      try {
        cancelledRef.current = false;
        sessionResultRef.current = resultHandler ?? resultRef.current;
        setLiveText(null);
        setState("requesting");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (
          generationRef.current !== generation ||
          cancelledRef.current ||
          !mountedRef.current
        ) {
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          if (generationRef.current === generation && mountedRef.current) {
            activeRef.current = false;
            setState("idle");
          }
          return false;
        }
        streamRef.current = stream;
        audioMeter.connect(stream);
        const mimeType = pickMime();
        const rec = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        chunksRef.current = [];
        const startedAt = Date.now();
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onerror = () => {
          if (generationRef.current !== generation) return;
          cancelledRef.current = true;
          logVoiceFailure("microphone recording failed");
          errorRef.current?.("Microphone recording failed");
          toast.error("Microphone recording failed");
          if (rec.state !== "inactive") rec.stop();
          else {
            recRef.current = null;
            activeRef.current = false;
            teardownStream();
            if (mountedRef.current) setState("idle");
          }
        };
        rec.onstop = async () => {
          recRef.current = null;
          const takeSeconds = (Date.now() - startedAt) / 1000;
          const blob = new Blob(chunksRef.current, {
            type: rec.mimeType || "audio/webm",
          });
          chunksRef.current = [];
          teardownStream();
          if (generationRef.current !== generation) return;
          if (cancelledRef.current || blob.size === 0) {
            cancelledRef.current = false;
            activeRef.current = false;
            if (mountedRef.current) setState("idle");
            settledRef.current?.();
            return;
          }
          if (mountedRef.current) setState("transcribing");
          try {
            let text: string;
            const sentenceFollower = onSentence ? follower : null;
            if (sentenceFollower && followed) {
              text = await finishSentences(sentenceFollower, followed);
            } else {
              // A recording that cannot be decoded here still goes to Whisper.
              if (
                skipSilenceRef.current &&
                (await peakLevel(blob).catch(() => 1)) < SILENCE_RMS
              ) {
                return;
              }
              text = await transcribeAudio(blob, sttProvider, apiKeys, {
                ...sttOptions,
                audioSeconds: takeSeconds,
              });
            }
            if (
              generationRef.current === generation &&
              !cancelledRef.current &&
              text.trim() &&
              mountedRef.current
            ) {
              await sessionResultRef.current(text.trim());
            }
          } catch (e) {
            console.error("stt.transcribe", e);
            const detail =
              e instanceof Error ? e.message : "Transcription failed";
            logVoiceFailure(`${sttProvider}, ${blob.size} bytes: ${detail}`);
            errorRef.current?.(detail);
            toast.error(detail);
          } finally {
            if (generationRef.current === generation) {
              activeRef.current = false;
              if (mountedRef.current) setState("idle");
              settledRef.current?.();
            }
          }
        };
        recRef.current = rec;
        rec.start(1_000);
        recordingTimerRef.current = setTimeout(() => {
          recordingTimerRef.current = null;
          if (rec.state !== "inactive") rec.stop();
        }, MAX_RECORDING_MS);
        setState("recording");
        void follow(stream);
        return true;
      } catch (e) {
        if (
          generationRef.current !== generation ||
          cancelledRef.current ||
          !mountedRef.current
        ) {
          teardownStream();
          return false;
        }
        console.error("stt.getUserMedia", e);
        logVoiceFailure(
          `microphone access failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        );
        errorRef.current?.("Microphone access failed");
        toast.error("Microphone access failed");
        activeRef.current = false;
        recRef.current = null;
        chunksRef.current = [];
        teardownStream();
        setState("idle");
        return false;
      }
    },
    [
      apiKeys,
      sttProvider,
      sttOptions,
      liveSource,
      state,
      supported,
      hasKey,
      whispercppBaseURL,
      teardownStream,
      audioMeter.connect,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      generationRef.current += 1;
      activeRef.current = false;
      mountedRef.current = false;
      cancelledRef.current = true;
      const rec = recRef.current;
      if (rec) {
        rec.ondataavailable = null;
        rec.onerror = null;
        rec.onstop = null;
      }
      if (rec && rec.state !== "inactive") rec.stop();
      teardownStream();
    };
  }, [teardownStream]);

  return {
    state,
    requesting: state === "requesting",
    recording: state === "recording",
    transcribing: state === "transcribing",
    /** The words heard so far, kept until the final text has gone out. */
    liveText:
      state === "recording" || state === "transcribing" ? liveText : null,
    start,
    stop,
    cancel,
    supported,
    hasKey,
    sttProvider,
    audioMeter,
  };
}
