import { buildSharedExtensions } from "@/modules/editor/lib/extensions";
import { EDITOR_THEME_EXT } from "@/modules/editor/lib/themes";
import { html } from "@codemirror/lang-html";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect } from "react";

const EXPECTED_TEXT = '<main data-theme="dark">Anbo</main>';

function reportEditorLayout(): void {
  const editor = document.querySelector<HTMLElement>(".cm-editor");
  const scroller = document.querySelector<HTMLElement>(".cm-scroller");
  const content = document.querySelector<HTMLElement>(".cm-content");
  const gutters = document.querySelector<HTMLElement>(".cm-gutters");
  const firstLine = document.querySelector<HTMLElement>(".cm-line");
  const gutterNumber = document.querySelector<HTMLElement>(
    ".cm-lineNumbers .cm-gutterElement",
  );
  const syntaxToken = document.querySelector<HTMLElement>(
    ".cm-content .tok-typeName",
  );
  const selectionLayer = document.querySelector<HTMLElement>(
    ".cm-scroller > .cm-selectionLayer",
  );
  const selectionMarker = selectionLayer?.querySelector<HTMLElement>(
    ".cm-selectionBackground",
  );
  const result = document.getElementById("editor-production-smoke");
  if (
    !editor ||
    !scroller ||
    !content ||
    !gutters ||
    !firstLine ||
    !gutterNumber ||
    !syntaxToken ||
    !selectionLayer ||
    !selectionMarker ||
    !result
  ) {
    document.documentElement.dataset.anboEditorSmoke = "fail";
    document.documentElement.dataset.anboEditorSmokeError =
      "CodeMirror layout or stable syntax token did not mount";
    return;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const guttersRect = gutters.getBoundingClientRect();
  const firstLineRect = firstLine.getBoundingClientRect();
  const scrollerStyle = getComputedStyle(scroller);
  const contentStyle = getComputedStyle(content);
  const firstLineStyle = getComputedStyle(firstLine);
  const gutterNumberStyle = getComputedStyle(gutterNumber);
  const syntaxTokenStyle = getComputedStyle(syntaxToken);
  const selectionLayerStyle = getComputedStyle(selectionLayer);
  const selectionMarkerStyle = getComputedStyle(selectionMarker);
  const selectionMarkerRect = selectionMarker.getBoundingClientRect();
  const textMatches = content.textContent?.includes("Anbo") ?? false;
  const lineInsideScroller =
    firstLineRect.top >= scrollerRect.top &&
    firstLineRect.top < scrollerRect.bottom &&
    firstLineRect.left >= scrollerRect.left &&
    firstLineRect.left < scrollerRect.right;
  const contentOverlapsScroller =
    contentRect.top < scrollerRect.bottom &&
    contentRect.bottom > scrollerRect.top;
  const horizontalEditorLayout =
    scrollerStyle.flexDirection === "row" &&
    guttersRect.left >= scrollerRect.left &&
    guttersRect.right <= contentRect.left + 1 &&
    contentRect.top < guttersRect.bottom &&
    contentRect.bottom > guttersRect.top;
  const visibleText =
    firstLineStyle.visibility !== "hidden" &&
    firstLineStyle.display !== "none" &&
    Number.parseFloat(firstLineStyle.opacity || "1") > 0;
  const chromeStyled =
    Number.parseFloat(gutterNumberStyle.opacity || "1") < 1 &&
    scrollerStyle.fontFamily.toLowerCase().includes("mono");
  const syntaxStyled =
    syntaxToken.classList.contains("tok-typeName") &&
    syntaxTokenStyle.color !== contentStyle.color;
  const nativeSelectionSuppressed =
    firstLineStyle.caretColor === "transparent" ||
    firstLineStyle.caretColor === "rgba(0, 0, 0, 0)";
  const selectionLayered =
    selectionLayerStyle.position === "absolute" &&
    selectionMarkerStyle.position === "absolute" &&
    selectionMarkerRect.left >= scrollerRect.left - 1 &&
    selectionMarkerRect.right <= scrollerRect.right + 1 &&
    selectionMarkerRect.top >= scrollerRect.top - 1 &&
    selectionMarkerRect.bottom <= firstLineRect.bottom + 1;
  const passed =
    textMatches &&
    scrollerStyle.display === "flex" &&
    lineInsideScroller &&
    contentOverlapsScroller &&
    horizontalEditorLayout &&
    visibleText &&
    chromeStyled &&
    syntaxStyled &&
    nativeSelectionSuppressed &&
    selectionLayered;

  document.documentElement.dataset.anboEditorSmoke = passed ? "pass" : "fail";
  result.dataset.result = passed ? "pass" : "fail";
  if (!passed) {
    document.documentElement.dataset.anboEditorSmokeError = JSON.stringify({
      textMatches,
      scrollerDisplay: scrollerStyle.display,
      lineInsideScroller,
      contentOverlapsScroller,
      horizontalEditorLayout,
      visibleText,
      chromeStyled,
      syntaxStyled,
      nativeSelectionSuppressed,
      selectionLayered,
      contentColor: contentStyle.color,
      syntaxColor: syntaxTokenStyle.color,
      gutterOpacity: gutterNumberStyle.opacity,
      fontFamily: scrollerStyle.fontFamily,
      caretColor: firstLineStyle.caretColor,
      selectionLayerPosition: selectionLayerStyle.position,
      selectionMarkerPosition: selectionMarkerStyle.position,
      selectionMarker: {
        left: selectionMarkerRect.left,
        top: selectionMarkerRect.top,
        right: selectionMarkerRect.right,
        bottom: selectionMarkerRect.bottom,
      },
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
      gutters: {
        left: guttersRect.left,
        top: guttersRect.top,
        right: guttersRect.right,
        bottom: guttersRect.bottom,
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
    const timer = window.setTimeout(reportEditorLayout, 150);
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
          selection={{ anchor: 1, head: EXPECTED_TEXT.length - 1 }}
          theme={EDITOR_THEME_EXT.atomone}
          extensions={[...buildSharedExtensions(), html()]}
          height="100%"
          className="anbo-code-editor"
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
