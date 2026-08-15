import { subscribeWindowPresentation } from "@/lib/windowPresentation";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { type RefObject, useEffect } from "react";

export function useEditorWindowPresentation(
  editorRef: RefObject<ReactCodeMirrorRef | null>,
): void {
  useEffect(
    () =>
      subscribeWindowPresentation((next) => {
        if (next === "ready") editorRef.current?.view?.requestMeasure();
      }),
    [editorRef],
  );
}
