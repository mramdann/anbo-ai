import { ResizablePanel } from "@/components/ui/resizable";
import { type ComponentProps, useState } from "react";

type SidebarPanelProps = Omit<
  ComponentProps<typeof ResizablePanel>,
  "defaultSize"
> & {
  /** The size the panel opens at. Read once, when the panel mounts. */
  initialSize: () => string;
};

/**
 * The sidebar's panel, with a default size that stays what it was when the
 * panel mounted.
 *
 * `react-resizable-panels` registers a panel again whenever its `defaultSize`
 * changes, the group then mounts again, and that ends a separator drag that
 * is under way. The sidebar opens at the width it was last dragged to, so the
 * value changes after every drag. Handed over as it changed, it reached the
 * panel at the next render of the app, and in an idle window that render is
 * the one the next drag's own press causes: every second drag of the
 * separator stopped after its first few pixels.
 */
export function SidebarPanel({ initialSize, ...props }: SidebarPanelProps) {
  const [defaultSize] = useState(initialSize);
  return <ResizablePanel {...props} defaultSize={defaultSize} />;
}
