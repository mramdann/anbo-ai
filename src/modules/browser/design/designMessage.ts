import type {
  BrowserDesignCapture,
  BrowserDesignMark,
} from "@/modules/browser/native";

export const MAX_DESIGN_MESSAGE_CHARS = 6_000;
const MAX_NOTE_CHARS = 240;
const MAX_NAME_CHARS = 60;
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
  "g",
);

const KIND_LABELS: Record<string, string> = {
  box: "area",
  pick: "element",
  arrow: "arrow",
  pen: "sketch",
};

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function quote(value: string): string {
  return `"${value.replace(/"/g, "'")}"`;
}

function describeLocator(mark: BrowserDesignMark): string {
  const element = mark.element;
  if (!element) return "";
  const locator = element.locator;
  if (locator?.by === "testId" && locator.value)
    return `testId ${clean(locator.value, 80)}`;
  if (locator?.by === "role" && locator.value)
    return `role ${clean(locator.value, 32)}${locator.name ? ` ${quote(clean(locator.name, MAX_NAME_CHARS))}` : ""}`;
  if (locator?.by === "text" && locator.value)
    return `text ${quote(clean(locator.value, 80))}`;
  const selector = clean(locator?.value ?? element.selector, 120);
  return selector ? `css ${selector}` : "";
}

export function describeDesignMark(mark: BrowserDesignMark): string {
  const kind = KIND_LABELS[String(mark.kind)] ?? clean(mark.kind, 16);
  const note = clean(mark.note, MAX_NOTE_CHARS);
  const parts = [`${mark.n}) ${kind}`];
  if (note) parts.push(quote(note));
  const element = mark.element;
  if (element?.tag) {
    const name = clean(element.name || element.text, MAX_NAME_CHARS);
    const locator = describeLocator(mark);
    parts.push(
      `-> <${clean(element.tag, 24)}>${name ? ` ${quote(name)}` : ""}${locator ? ` [${locator}]` : ""}`,
    );
  }
  if (mark.inViewport === false) parts.push("(outside the captured viewport)");
  return parts.join(" ");
}

/**
 * One line for the agent's prompt. Terminal delivery collapses newlines, so
 * the structure lives in the JSON on disk and the line only has to say what
 * happened, where the files are, and what each numbered mark asks for.
 */
export function buildDesignMessage(
  capture: BrowserDesignCapture,
  userMessage: string,
  maxChars = MAX_DESIGN_MESSAGE_CHARS,
): string {
  const marks = Array.isArray(capture.marks) ? capture.marks : [];
  const title = clean(capture.title, 80);
  const url = clean(capture.url, 400);
  const head = `Design feedback from Anbo on ${url}${title ? ` (${quote(title)})` : ""}, ${marks.length} mark${marks.length === 1 ? "" : "s"}. Annotated capture: ${clean(capture.imagePath, 400)} (numbered badges match the list below). Details with locators for browser_find: ${clean(capture.jsonPath, 400)}.`;
  const extra = clean(userMessage, 1_500);
  const tail = extra ? ` From the user: ${extra}` : "";
  const items = marks.map(describeDesignMark);
  let budget = maxChars - head.length - tail.length - " Marks: .".length;
  const included: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const omitted = `(+${items.length - index} more in the JSON)`;
    const cost = item.length + (included.length ? 2 : 0);
    if (cost + omitted.length + 2 > budget) {
      included.push(omitted);
      break;
    }
    included.push(item);
    budget -= cost;
  }
  const list = included.length ? ` Marks: ${included.join("; ")}.` : "";
  return `${head}${list}${tail}`.slice(0, maxChars);
}
