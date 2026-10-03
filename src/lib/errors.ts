/** The message a thrown value carries, or `fallback` when it has none. */
export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}
