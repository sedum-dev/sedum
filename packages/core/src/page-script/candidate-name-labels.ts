interface LabelDependencies {
  publicText(element: Element, visualOnly?: boolean, ownOnly?: boolean): string;
}

function normalizedText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function createLabelNames({ publicText }: LabelDependencies) {
  function referencedLabelText(element: Element): string {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (
        !parent?.closest(
          "script,style,noscript,input,textarea,select,[contenteditable]",
        )
      )
        parts.push(walker.currentNode.textContent ?? "");
    }
    return normalizedText(parts.join(" "));
  }

  function ariaLabel(element: Element): string {
    return element.getAttribute("aria-label")?.trim() ?? "";
  }

  function labelledByText(element: Element): string {
    return (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .map((node) => (node ? referencedLabelText(node) : ""))
      .filter(Boolean)
      .join(" ");
  }

  function nativeLabelText(element: Element): string {
    if (!(element instanceof HTMLElement) || !("labels" in element)) return "";
    const labels = (element as HTMLInputElement).labels;
    if (!labels?.length) return "";
    return Array.from(labels)
      .map((label) => publicText(label))
      .join(" ")
      .trim();
  }

  function placeholderText(element: Element): string {
    if (!(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ))
      return "";
    return element.getAttribute("placeholder")?.trim() ?? "";
  }

  function inputButtonValue(element: Element): string {
    if (!(element instanceof HTMLInputElement)) return "";
    if (!["button", "submit", "reset"].includes(element.type)) return "";
    return element.value.trim();
  }

  function ownText(element: Element, visualOnly: boolean): string {
    return publicText(element, visualOnly, true);
  }

  function titleText(element: Element): string {
    return element.getAttribute("title")?.trim() ?? "";
  }

  function label(element: Element, visualOnly = false): string {
    const sources = [
      ariaLabel,
      labelledByText,
      nativeLabelText,
      placeholderText,
      inputButtonValue,
      (node: Element) => ownText(node, visualOnly),
      titleText,
    ];
    for (const source of sources) {
      const value = source(element);
      if (value) return value;
    }
    return "";
  }

  return { referencedLabelText, label };
}
