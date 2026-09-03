import {
  failedVoiceInsert,
  successfulVoiceInsert,
  type VoiceTarget,
} from "@/modules/voice/lib/voiceTarget";

const TEXT_INPUT_TYPES = new Set(["", "email", "search", "tel", "text", "url"]);

type TextControl = HTMLInputElement | HTMLTextAreaElement;

function isTextControl(element: Element): element is TextControl {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      TEXT_INPUT_TYPES.has(element.type.toLowerCase()))
  );
}

function fieldLabel(element: HTMLElement): string {
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder") ||
    element.getAttribute("title");
  return label?.trim() || "Text field";
}

function setNativeValue(element: TextControl, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function captureTextControl(element: TextControl): VoiceTarget {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const valueAtCapture = element.value;
  const label = fieldLabel(element);

  return {
    kind: "dom",
    label,
    insert: (text) => {
      if (!element.isConnected || element.getClientRects().length === 0) {
        return failedVoiceInsert("The original input is no longer available.");
      }
      if (element.disabled || element.readOnly) {
        return failedVoiceInsert("The original input is not editable.");
      }
      if (element.value !== valueAtCapture) {
        return failedVoiceInsert(
          "The input changed while AnboVoice was listening. The transcript was not inserted.",
        );
      }
      const next = `${valueAtCapture.slice(0, start)}${text}${valueAtCapture.slice(end)}`;
      const caret = start + text.length;
      setNativeValue(element, next);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: text,
          inputType: "insertText",
        }),
      );
      element.focus({ preventScroll: true });
      element.setSelectionRange(caret, caret);
      return successfulVoiceInsert();
    },
  };
}

function rangeInside(element: HTMLElement, range: Range): boolean {
  return element.contains(range.commonAncestorContainer);
}

function captureContentEditable(element: HTMLElement): VoiceTarget {
  const selection = window.getSelection();
  const captured =
    selection && selection.rangeCount > 0
      ? selection.getRangeAt(0).cloneRange()
      : null;
  const range = captured && rangeInside(element, captured) ? captured : null;
  const textAtCapture = element.textContent;
  const label = fieldLabel(element);

  return {
    kind: "dom",
    label,
    insert: (text) => {
      if (
        !element.isConnected ||
        element.getClientRects().length === 0 ||
        !element.isContentEditable
      ) {
        return failedVoiceInsert("The original input is no longer available.");
      }
      if (element.textContent !== textAtCapture) {
        return failedVoiceInsert(
          "The input changed while AnboVoice was listening. The transcript was not inserted.",
        );
      }
      element.focus({ preventScroll: true });
      const currentSelection = window.getSelection();
      if (!currentSelection) {
        return failedVoiceInsert("The input cursor could not be restored.");
      }
      const insertionRange = range?.cloneRange() ?? document.createRange();
      if (!range) {
        insertionRange.selectNodeContents(element);
        insertionRange.collapse(false);
      }
      currentSelection.removeAllRanges();
      currentSelection.addRange(insertionRange);
      if (document.execCommand("insertText", false, text)) {
        return successfulVoiceInsert();
      }
      insertionRange.deleteContents();
      const node = document.createTextNode(text);
      insertionRange.insertNode(node);
      insertionRange.setStartAfter(node);
      insertionRange.collapse(true);
      currentSelection.removeAllRanges();
      currentSelection.addRange(insertionRange);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: text,
          inputType: "insertText",
        }),
      );
      return successfulVoiceInsert();
    },
  };
}

function blockedTarget(label: string, message: string): VoiceTarget {
  return {
    kind: "blocked",
    label,
    insert: () => failedVoiceInsert(message),
  };
}

export function captureDomVoiceTarget(
  activeElement: Element | null = document.activeElement,
): VoiceTarget | null {
  if (!(activeElement instanceof HTMLElement)) return null;
  if (activeElement.closest("[data-anbo-voice-overlay]")) return null;
  if (activeElement.closest(".xterm, .cm-content")) return null;
  if (
    activeElement instanceof HTMLInputElement &&
    activeElement.type.toLowerCase() === "password"
  ) {
    return blockedTarget(
      "Password field",
      "AnboVoice does not insert text into password fields.",
    );
  }
  if (isTextControl(activeElement)) {
    return captureTextControl(activeElement);
  }
  const editable = activeElement.isContentEditable
    ? activeElement
    : activeElement.closest<HTMLElement>("[contenteditable='true']");
  return editable ? captureContentEditable(editable) : null;
}
