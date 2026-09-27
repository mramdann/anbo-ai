(() => {
  let element = document.activeElement;
  for (let depth = 0; depth < 32; depth += 1) {
    if (!element) return "none";
    if (element instanceof HTMLIFrameElement) {
      try {
        if (!element.contentDocument) return "frame";
        element = element.contentDocument.activeElement;
        continue;
      } catch { return "frame"; }
    }
    if (element.shadowRoot?.activeElement) {
      element = element.shadowRoot.activeElement;
      continue;
    }
    if (element.disabled || element.readOnly) return "none";
    const tag = element.tagName?.toLowerCase();
    if (tag === "input") {
      if (element.type === "password") return "password";
      return ["text", "search", "email", "url", "tel"].includes(element.type) ? "editable" : "none";
    }
    return tag === "textarea" || element.isContentEditable ? "editable" : "none";
  }
  return "none";
})()
