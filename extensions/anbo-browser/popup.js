const profile = document.querySelector("#profile");
const status = document.querySelector("#status");
const buttons = Object.fromEntries(["connect", "disconnect", "refresh"].map((id) => [id, document.querySelector(`#${id}`)]));

async function run(type) {
  for (const button of Object.values(buttons)) button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type, name: profile.value });
    if (!response?.ok) throw new Error(response?.error ?? "Browser bridge unavailable");
    const result = response.result;
    if (!profile.value) profile.value = result.name;
    profile.disabled = result.connected;
    buttons.connect.disabled = result.connected || result.busy;
    buttons.disconnect.disabled = !result.connected;
    status.textContent = result.error || (result.approved
      ? `Connected. ${result.selected} tab(s) selected. Choose or open tabs directly in Anbo; no sharing step is needed here.`
      : result.connected ? "Waiting for approval in Anbo > New browser tab > Connect Chrome / Edge." : "Disconnected. Start the Anbo development build and connect this profile.");
  } catch (error) {
    status.textContent = String(error.message ?? error);
    buttons.connect.disabled = false;
    buttons.disconnect.disabled = false;
  } finally {
    buttons.refresh.disabled = false;
  }
}

for (const [type, button] of Object.entries(buttons)) {
  button.addEventListener("click", () => void run(type === "refresh" ? "status" : type));
}
void run("status");
