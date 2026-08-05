import { cn } from "@/lib/utils";
import type { PreviewTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import { PreviewPane, type PreviewPaneHandle } from "./PreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onUrlChange: (id: number, url: string) => void;
  onTitleChange: (id: number, title: string) => void;
  registerHandle: (id: number, handle: PreviewPaneHandle | null) => void;
};

export function PreviewStack({
  tabs,
  activeId,
  onUrlChange,
  onTitleChange,
  registerHandle,
}: Props) {
  const previews = tabs.filter(
    (t): t is PreviewTab => t.kind === "preview" && !t.cold,
  );

  const registerRef = useRef(registerHandle);
  const urlChangeRef = useRef(onUrlChange);
  const titleChangeRef = useRef(onTitleChange);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    urlChangeRef.current = onUrlChange;
  }, [onUrlChange]);
  useEffect(() => {
    titleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  const refCallbacks = useRef(
    new Map<number, (h: PreviewPaneHandle | null) => void>(),
  );
  const urlCallbacks = useRef(new Map<number, (url: string) => void>());
  const titleCallbacks = useRef(new Map<number, (title: string) => void>());

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: PreviewPaneHandle | null) => registerRef.current(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getUrlCallback = (id: number) => {
    let cb = urlCallbacks.current.get(id);
    if (!cb) {
      cb = (url: string) => urlChangeRef.current(id, url);
      urlCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getTitleCallback = (id: number) => {
    let cb = titleCallbacks.current.get(id);
    if (!cb) {
      cb = (title: string) => titleChangeRef.current(id, title);
      titleCallbacks.current.set(id, cb);
    }
    return cb;
  };

  useEffect(() => {
    const live = new Set(previews.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of urlCallbacks.current.keys()) {
      if (!live.has(id)) urlCallbacks.current.delete(id);
    }
    for (const id of titleCallbacks.current.keys()) {
      if (!live.has(id)) titleCallbacks.current.delete(id);
    }
  }, [previews]);

  if (previews.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {previews.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <PreviewPane
              ref={getRefCallback(t.id)}
              id={t.id}
              url={t.url}
              visible={visible}
              onUrlChange={getUrlCallback(t.id)}
              onTitleChange={getTitleCallback(t.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
