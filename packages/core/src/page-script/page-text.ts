import {
  DIGEST_LIMIT,
  PAGE_PROTOCOL,
  type DigestResult,
  type PageVersion,
} from "../page-protocol.js";

interface PageTextDependencies {
  readonly version: () => PageVersion;
  readonly modal: () => Element | null | undefined;
  readonly visible: (element: Element, visualOnly?: boolean) => boolean;
  readonly excludedTextAncestor: (element: Element) => boolean;
  readonly label: (element: Element) => string;
  readonly countBadgeKind: (element: Element, text: string) => string;
  readonly maxTextNodes: number;
}

type TextState = {
  readonly pieces: string[];
  readonly emitted: Set<Element>;
  size: number;
};

type NodeResult = "skip" | "added" | "too-large";

export function createPageText(dependencies: PageTextDependencies): {
  digest(): DigestResult;
  visibleText(): DigestResult;
} {
  const {
    version,
    modal,
    visible,
    excludedTextAncestor,
    label,
    countBadgeKind,
    maxTextNodes,
  } = dependencies;

  /** A native select, or a combobox with no text entry anywhere inside it. */
  function selectOnly(control: Element): boolean {
    if (control instanceof HTMLSelectElement) return true;
    if (!nonEditableCombobox(control)) return false;
    const autocomplete = control.getAttribute("aria-autocomplete");
    return autocomplete === null || autocomplete.toLowerCase() === "none";
  }

  function nonEditableCombobox(control: Element): boolean {
    if (control.getAttribute("role") !== "combobox") return false;
    if (control.matches("input,textarea")) return false;
    if (isEditable(control)) return false;
    if (hasEditableDescendant(control)) return false;
    return !hasExcludedParent(control);
  }

  function isEditable(control: Element): boolean {
    return control instanceof HTMLElement && control.isContentEditable;
  }

  function hasExcludedParent(control: Element): boolean {
    return (
      !!control.parentElement && excludedTextAncestor(control.parentElement)
    );
  }

  function hasEditableDescendant(control: Element): boolean {
    return !!control.querySelector(
      "input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='searchbox'],[role='spinbutton']",
    );
  }

  function selectedText(control: Element): string {
    if (control instanceof HTMLSelectElement)
      return normalize(control.selectedOptions[0]?.textContent ?? "");
    return customSelectedText(control);
  }

  function customSelectedText(control: Element): string {
    const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (isSelectedTextParent(parent))
        parts.push(walker.currentNode.textContent ?? "");
    }
    return normalize(parts.join(" "));
  }

  function isSelectedTextParent(parent: Element | null): parent is Element {
    if (!parent || !visible(parent, true)) return false;
    return !parent.closest(
      "input,textarea,select,[contenteditable],script,style,noscript,[role='textbox'],[role='searchbox'],[role='spinbutton'],[role='listbox'],[role='option']",
    );
  }

  function normalize(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  function incomplete(
    current: PageVersion,
    error: NonNullable<DigestResult["error"]>,
  ): DigestResult {
    return {
      protocol: PAGE_PROTOCOL,
      version: current,
      text: "",
      complete: false,
      error,
    };
  }

  function append(state: TextState, part: string, limit: number): NodeResult {
    if (!part) return "skip";
    state.size += Array.from(part).length + (state.pieces.length ? 1 : 0);
    if (state.size > limit) return "too-large";
    state.pieces.push(part);
    return "added";
  }

  function selectionPart(control: Element): string {
    const selection = selectedText(control);
    if (!selection) return "";
    const name = label(control)
      .replace(selection, "")
      .replace(/^[\s.,:;–-]+|[\s.,:;–-]+$/g, "");
    return name ? `${name}: ${selection}` : selection;
  }

  function processSelection(
    control: Element,
    state: TextState,
    limit: number,
  ): NodeResult {
    if (state.emitted.has(control) || !visible(control)) return "skip";
    state.emitted.add(control);
    return append(state, selectionPart(control), limit);
  }

  function processNode(
    node: Node,
    state: TextState,
    limit: number,
  ): NodeResult {
    const parent = node.parentElement;
    const control = parent?.closest("select,[role='combobox']");
    if (control && isSelectionControl(control, state))
      return processSelection(control, state, limit);
    if (!isPublicTextParent(parent)) return "skip";
    const text = normalize(node.textContent ?? "");
    if (!text) return "skip";
    const kind = badgeKind(parent, text);
    return append(state, kind ? `${kind} icon badge: ${text}` : text, limit);
  }

  function isSelectionControl(control: Element, state: TextState): boolean {
    return state.emitted.has(control) || selectOnly(control);
  }

  function isPublicTextParent(parent: Element | null): parent is Element {
    if (!parent || !visible(parent)) return false;
    return !excludedTextAncestor(parent);
  }

  function badgeKind(parent: Element, text: string): string {
    if (!/^\d{1,4}\+?$/.test(text)) return "";
    return countBadgeKind(parent, text);
  }

  /** The visible text a person reads, in the topmost dialog if one is open. */
  function pageText(limit: number): DigestResult {
    const current = version();
    const selectedModal = modal();
    if (selectedModal === undefined)
      return incomplete(current, "scope_ambiguous");
    const root = selectedModal ?? document.body;
    if (!root)
      return {
        protocol: PAGE_PROTOCOL,
        version: current,
        text: "",
        complete: true,
      };
    return walkText(root, current, limit);
  }

  function walkText(
    root: Element,
    current: PageVersion,
    limit: number,
  ): DigestResult {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const state: TextState = { pieces: [], emitted: new Set(), size: 0 };
    let count = 0;
    while (walker.nextNode()) {
      if (++count > maxTextNodes)
        return incomplete(current, "resource_ceiling");
      if (processNode(walker.currentNode, state, limit) === "too-large")
        return incomplete(current, "digest_too_large");
    }
    return {
      protocol: PAGE_PROTOCOL,
      version: current,
      text: state.pieces.join(" "),
      complete: true,
    };
  }

  return {
    digest: () => pageText(DIGEST_LIMIT),
    visibleText: () => pageText(Number.MAX_SAFE_INTEGER),
  };
}
