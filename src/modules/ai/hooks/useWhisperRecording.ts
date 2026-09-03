import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { transcribeAudio, type SttOptions } from "../lib/stt";
import type { SttProvider } from "../config";

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
}: {
  onResult: (text: string) => void;
}) {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const sttProvider = usePreferencesStore((s) => s.sttProvider);
  const groqSttModel = usePreferencesStore((s) => s.groqSttModel);
  const whispercppBaseURL = usePreferencesStore((s) => s.whispercppBaseURL);
  const [state, setState] = useState<State>("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const resultRef = useRef(onResult);
  const sessionResultRef = useRef(onResult);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  resultRef.current = onResult;

  const needsKey = providerNeedsKey(sttProvider);
  const providerKey = needsKey ? getApiKeyForStt(apiKeys, sttProvider) : null;
  const hasKey = needsKey ? !!providerKey : true;

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const sttOptions = useMemo<SttOptions>(
    () => ({ groqSttModel, whispercppBaseURL }),
    [groqSttModel, whispercppBaseURL],
  );

  const teardownStream = useCallback(() => {
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    activeRef.current = false;
    cancelledRef.current = true;
    chunksRef.current = [];
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    else {
      teardownStream();
      if (mountedRef.current) setState("idle");
    }
  }, [teardownStream]);

  const start = useCallback(
    async (resultHandler?: (text: string) => void) => {
      if (!supported || !hasKey || state !== "idle" || activeRef.current) {
        return false;
      }
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = true;
      try {
        cancelledRef.current = false;
        sessionResultRef.current = resultHandler ?? resultRef.current;
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
        const mimeType = pickMime();
        const rec = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onerror = () => {
          if (generationRef.current !== generation) return;
          cancelledRef.current = true;
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
            return;
          }
          if (mountedRef.current) setState("transcribing");
          try {
            const text = await transcribeAudio(
              blob,
              sttProvider,
              apiKeys,
              sttOptions,
            );
            if (
              generationRef.current === generation &&
              !cancelledRef.current &&
              text.trim() &&
              mountedRef.current
            ) {
              sessionResultRef.current(text.trim());
            }
          } catch (e) {
            console.error("stt.transcribe", e);
            toast.error(
              e instanceof Error ? e.message : "Transcription failed",
            );
          } finally {
            if (generationRef.current === generation) {
              activeRef.current = false;
              if (mountedRef.current) setState("idle");
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
      state,
      supported,
      hasKey,
      teardownStream,
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
    start,
    stop,
    cancel,
    supported,
    hasKey,
    sttProvider,
  };
}
