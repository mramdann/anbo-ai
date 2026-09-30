import { failureView, popupView } from "./popup-view.js";

const element = (id) => document.getElementById(id);
const profile = element("profile");
const buttons = { connect: element("connect"), disconnect: element("disconnect"), refresh: element("refresh") };
const browser = navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
let connected = false;

element("subtitle").textContent = `Use this ${browser} profile in Anbo`;

function show(view) {
  element("state").dataset.tone = view.tone;
  element("headline").textContent = view.headline;
  element("detail").replaceChildren(...view.detail.map((part) => {
    if (typeof part === "string") return part;
    const strong = document.createElement("b");
    strong.textContent = part.strong;
    return strong;
  }));
  element("form").hidden = false;
  element("setup").hidden = view.connected;
  buttons.connect.hidden = view.connected;
  buttons.disconnect.hidden = !view.connected;
}

async function run(type) {
  for (const button of Object.values(buttons)) button.disabled = true;
  buttons.refresh.setAttribute("aria-busy", "true");
  try {
    const response = await chrome.runtime.sendMessage({ type, name: profile.value });
    if (!response?.ok) throw new Error(response?.error ?? "Browser bridge unavailable");
    const result = response.result;
    if (!profile.value) profile.value = result.name;
    connected = result.connected;
    show(popupView(result));
    buttons.connect.disabled = result.connected || result.busy;
    buttons.disconnect.disabled = !result.connected;
    // Anbo names an unlabelled profile a moment after it connects.
    if (type === "connect" && result.connected && !result.label) setTimeout(() => void run("status"), 600);
  } catch (error) {
    show(failureView(type, error, connected));
    buttons.connect.disabled = false;
    buttons.disconnect.disabled = false;
  } finally {
    buttons.refresh.disabled = false;
    buttons.refresh.removeAttribute("aria-busy");
  }
}

element("form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!buttons.connect.hidden && !buttons.connect.disabled) void run("connect");
});
buttons.disconnect.addEventListener("click", () => void run("disconnect"));
buttons.refresh.addEventListener("click", () => void run("status"));
void run("status");
