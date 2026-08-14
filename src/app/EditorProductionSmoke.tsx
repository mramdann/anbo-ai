import { buildSharedExtensions } from "@/modules/editor/lib/extensions";
import { EDITOR_THEME_EXT } from "@/modules/editor/lib/themes";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect } from "react";

const EXPECTED_TEXT = "# Logs\nnode_modules\ndist";

function reportEditorLayout(): void {
  const editor = document.querySelector<HTMLElement>(".cm-editor");
  const scroller = document.querySelector<HTMLElement>(".cm-scroller");
  const content = document.querySelector<HTMLElement>(".cm-content");
  const firstLine = document.querySelector<HTMLElement>(".cm-line");
  const result = document.getElementById("editor-production-smoke");
  if (!editor || !scroller || !content || !firstLine || !result) {
    document.documentElement.dataset.anboEditorSmoke = "fail";
    document.documentElement.dataset.anboEditorSmokeError =
      "CodeMirror DOM did not mount";
    return;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const firstLineRect = firstLine.getBoundingClientRect();
  const scrollerStyle = getComputedStyle(scroller);
  const firstLineStyle = getComputedStyle(firstLine);
  const textMatches = content.textContent?.includes("# Logs") ?? false;
  const lineInsideScroller =
    firstLineRect.top >= scrollerRect.top &&
    firstLineRect.top < scrollerRect.bottom &&
    firstLineRect.left >= scrollerRect.left &&
    firstLineRect.left < scrollerRect.right;
  const contentOverlapsScroller =
    contentRect.top < scrollerRect.bottom &&
    contentRect.bottom > scrollerRect.top;
  const visibleText =
    firstLineStyle.visibility !== "hidden" &&
    firstLineStyle.display !== "none" &&
    Number.parseFloat(firstLineStyle.opacity || "1") > 0;
  const passed =
    textMatches &&
    scrollerStyle.display === "flex" &&
    lineInsideScroller &&
    contentOverlapsScroller &&
    visibleText;

  document.documentElement.dataset.anboEditorSmoke = passed ? "pass" : "fail";
  result.dataset.result = passed ? "pass" : "fail";
  if (!passed) {
    document.documentElement.dataset.anboEditorSmokeError = JSON.stringify({
      textMatches,
      scrollerDisplay: scrollerStyle.display,
      lineInsideScroller,
      contentOverlapsScroller,
      visibleText,
      scroller: {
        left: scrollerRect.left,
        top: scrollerRect.top,
        right: scrollerRect.right,
        bottom: scrollerRect.bottom,
      },
      content: {
        left: contentRect.left,
        top: contentRect.top,
        right: contentRect.right,
        bottom: contentRect.bottom,
      },
      firstLine: {
        left: firstLineRect.left,
        top: firstLineRect.top,
        right: firstLineRect.right,
        bottom: firstLineRect.bottom,
      },
    });
  }
}

export default function EditorProductionSmoke() {
  useEffect(() => {
    const timer = window.setTimeout(reportEditorLayout, 100);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="h-screen bg-background p-4 text-foreground">
      <div
        id="editor-production-smoke"
        className="h-64 overflow-hidden rounded border border-border"
      >
        <CodeMirror
          value={EXPECTED_TEXT}
          theme={EDITOR_THEME_EXT.atomone}
          extensions={[...buildSharedExtensions()]}
          height="100%"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            highlightActiveLine: true,
          }}
        />
      </div>
    </main>
  );
}
