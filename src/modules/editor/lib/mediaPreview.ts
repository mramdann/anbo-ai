export type MediaPreview = "image" | "video" | "audio" | "pdf";

const IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"];
const VIDEOS = ["mp4", "webm", "ogg", "mov"];
const AUDIO = ["mp3", "wav", "flac", "aac", "m4a"];

/**
 * What the editor shows of a file it does not open as text. A ".pdf" goes
 * into a frame only when it starts as a PDF: the asset protocol serves a file
 * by what it looks like, and one that is a web page would run in that frame.
 */
export function mediaPreviewFor(
  path: string,
  startsAsPdf: boolean,
): MediaPreview | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGES.includes(ext)) return "image";
  if (VIDEOS.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  if (ext === "pdf" && startsAsPdf) return "pdf";
  return null;
}
