// What the popup shows for a status reply from the background worker. A label
// stays data ({ strong }) so the page renders it as text, never as markup.
export function popupView(result) {
  const label = String(result?.label ?? "");
  if (result?.approved) {
    const count = Number.isSafeInteger(result.selected) && result.selected > 0 ? result.selected : 0;
    return {
      tone: "ok",
      headline: label ? `Connected as ${label}` : "Connected",
      detail: [count ? `${count} ${count === 1 ? "tab" : "tabs"} in Anbo.` : "Open tabs from the browser menu at the top of Anbo, or from a new browser tab there."],
      connected: true,
    };
  }
  if (result?.connected) {
    return {
      tone: "wait",
      headline: "Waiting for approval",
      detail: ["Approve ", label ? { strong: label } : "this profile", " in Anbo: the browser menu at the top shows the request."],
      connected: true,
    };
  }
  if (result?.busy) return { tone: "idle", headline: "Disconnecting", detail: ["Closing this profile's connection to Anbo."], connected: false };
  if (result?.error) return { tone: "bad", headline: "Not connected", detail: [String(result.error)], connected: false };
  return { tone: "idle", headline: "Not connected", detail: ["Start Anbo, then connect this profile."], connected: false };
}

export function failureView(type, error, connected) {
  const headline = { connect: "Could not connect", disconnect: "Could not disconnect" }[type] ?? "Status unavailable";
  return { tone: "bad", headline, detail: [String(error?.message ?? error)], connected };
}
