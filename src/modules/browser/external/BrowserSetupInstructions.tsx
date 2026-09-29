import { Button } from "@/components/ui/button";

export type BrowserSetupResult = {
  browser: "chrome" | "edge";
  extensionPath: string;
  extensionsUrl: string;
  warning: string | null;
};

export type SetupCopy = "address" | "folder";

export function BrowserSetupInstructions({
  setup,
  copied,
  onCopy,
}: {
  setup: BrowserSetupResult;
  copied: SetupCopy | null;
  onCopy: (what: SetupCopy) => void;
}) {
  const browser = setup.browser === "chrome" ? "Chrome" : "Edge";
  return (
    <section className="grid gap-2 rounded-lg border p-3">
      <strong role="status">
        {browser} bridge installed. Allow the extension next.
      </strong>
      <p className="text-muted-foreground">
        {browser} does not let other apps open {setup.extensionsUrl}, so paste
        it into the address bar of the {browser} window Setup opened, in your
        chosen profile. There, enable Developer mode, then choose Load unpacked
        and select this folder:
      </p>
      <code className="select-text break-all rounded bg-muted p-2 text-[11px]">
        {setup.extensionPath}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onCopy("address")}>
          {copied === "address"
            ? "Address copied"
            : `Copy ${setup.extensionsUrl}`}
        </Button>
        <Button variant="outline" size="sm" onClick={() => onCopy("folder")}>
          {copied === "folder" ? "Folder path copied" : "Copy extension folder"}
        </Button>
      </div>
      <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
        <li>
          Open the Anbo extension, enter a profile label, then Connect profile.
        </li>
        <li>Return here and approve that profile for your workspace.</li>
        <li>
          Choose an available tab or open a URL directly in Anbo. No Share step
          is needed.
        </li>
      </ol>
      <p className="text-muted-foreground">
        Already installed? Keep the extension and connect your profile. After an
        Anbo update, reload the extension if needed. Setup does not grant tab
        control.
      </p>
      {setup.warning ? <p role="alert">{setup.warning}</p> : null}
    </section>
  );
}
