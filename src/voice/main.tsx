import "../styles/globals.css";
import "./voice.css";

import { ThemeProvider } from "@/modules/theme";
import ReactDOM from "react-dom/client";
import { GlobalVoiceApp } from "./GlobalVoiceApp";

ReactDOM.createRoot(
  document.getElementById("voice-root") as HTMLElement,
).render(
  <ThemeProvider>
    <GlobalVoiceApp />
  </ThemeProvider>,
);
