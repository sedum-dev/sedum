import { createNameHint } from "./candidate-name-hints.js";
import { iconKind } from "./candidate-name-icons.js";
import { createLabelNames } from "./candidate-name-labels.js";
import { createSpatialNames } from "./candidate-name-spatial.js";

export interface CandidateNameDependencies {
  allElements(
    root: Element,
    limit: number,
    skipDrawings?: boolean,
  ): Element[] | null;
  composedParent(element: Element): Element | null;
  deepContains(ancestor: Element, node: Element): boolean;
  excludedTextAncestor(element: Element, includeActions?: boolean): boolean;
  flatTextNodes(root: Node): Text[];
  interactive(element: Element): boolean;
  publicText(element: Element, visualOnly?: boolean, ownOnly?: boolean): string;
  role(element: Element): string;
  visible(
    element: Element,
    visualOnly?: boolean,
    ignoreOwnOpacity?: boolean,
  ): boolean;
  insideNestedControl(element: Element, node: Element): boolean;
  ariaHiddenOnly(element: Element): boolean;
}

/** Internal candidate naming backed by flat-tree DOM primitives. */
export function createCandidateNamesImplementation(
  dependencies: CandidateNameDependencies,
) {
  const {
    allElements,
    composedParent,
    flatTextNodes,
    interactive,
    publicText,
    role,
    visible,
    insideNestedControl,
    ariaHiddenOnly,
  } = dependencies;
  const { referencedLabelText, label } = createLabelNames({ publicText });
  const { nearbyText, rowLabel } = createSpatialNames(dependencies);

  function mediaName(element: Element): string {
    const selector = "img[alt],svg[aria-label],svg title,[aria-label]";
    for (const node of Array.from(element.querySelectorAll(selector))) {
      const drawn = node.matches("svg title") ? node.closest("svg")! : node;
      if (interactive(node) || !visible(drawn, true)) continue;
      const text = mediaText(node);
      if (text) return text;
    }
    return "";
  }

  function mediaText(node: Element): string {
    const text =
      node instanceof HTMLImageElement
        ? node.alt
        : node.matches("svg title")
          ? (node.textContent ?? "")
          : (node.getAttribute("aria-label") ?? "");
    return text.replace(/\s+/g, " ").trim();
  }

  function hostLabel(element: Element): string {
    const root = element.getRootNode();
    if (!(root instanceof ShadowRoot)) return "";
    const host = root.host;
    const aria = host.getAttribute("aria-label")?.trim();
    if (!aria || interactive(host)) return "";
    const inside = allElements(host, 500) ?? [];
    return inside.filter((node) => interactive(node)).length === 1 ? aria : "";
  }

  function iconName(element: Element): string {
    for (const node of Array.from(element.querySelectorAll("i,span,em"))) {
      if (node.textContent?.trim() || !node.getClientRects().length) continue;
      if (insideNestedControl(element, node)) continue;
      const name = iconClassName(node.classList);
      if (name) return name;
    }
    return "";
  }

  function iconClassName(classes: DOMTokenList): string {
    for (const token of Array.from(classes)) {
      const match =
        /^(?:fa|bi|glyphicon|icon|mdi|ti|ri)-([a-z][a-z0-9-]*)$/.exec(token);
      if (match && !isIconModifier(match[1]!))
        return match[1]!.replace(/-/g, " ");
    }
    return "";
  }

  function isIconModifier(name: string): boolean {
    return /^(lg|[0-9]x|fw|solid|regular|light|brands|spin|pulse|border|inverse|stack.*|rotate.*|flip.*)$/.test(
      name,
    );
  }

  function describedText(element: Element): string {
    const ids = element.getAttribute("aria-describedby");
    if (!ids || role(element) !== "combobox") return "";
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .map((node) => (node && visible(node) ? publicText(node) : ""))
      .filter(Boolean)
      .join(" ")
      .slice(0, 80);
  }

  function hiddenControlText(element: Element): string {
    const parts: string[] = [];
    for (const node of flatTextNodes(element)) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          "script,style,noscript,input,textarea,select,[contenteditable]",
        )
      )
        continue;
      if (!insideNestedControl(element, parent))
        parts.push(node.textContent ?? "");
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function candidateName(element: Element, hoverRevealed = false): string {
    const sources = [
      () => label(element, ariaHiddenOnly(element)),
      () => (hoverRevealed ? hiddenControlText(element) : ""),
      mediaName,
      nearbyText,
      hostLabel,
      iconName,
      describedText,
      rowLabel,
    ];
    for (const source of sources) {
      const result = source(element);
      if (result) return result;
    }
    return "";
  }

  const nameHint = createNameHint(dependencies, {
    referencedLabelText,
    nearbyText,
    rowLabel,
  });

  function countBadgeKind(node: Element, count: string): string {
    const tokens: string[] = [];
    const control = collectBadgeTokens(node, tokens);
    if (!control || publicText(control, true).replace(/\s+/g, "") !== count)
      return "";
    return iconKind(tokens);
  }

  function collectBadgeTokens(node: Element, tokens: string[]): Element | null {
    let current: Element | null = node;
    for (
      let depth = 0;
      current && current !== document.body && depth < 4;
      depth++
    ) {
      tokens.push(...elementTokens(current));
      if (interactive(current)) return current;
      current = composedParent(current);
    }
    return null;
  }

  function elementTokens(element: Element): string[] {
    return [
      element.getAttribute("class") ?? "",
      element.id,
      element.getAttribute("data-test") ?? "",
      element.getAttribute("data-testid") ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase()
      .split(/\s+/)
      .map((token) => token.replace(/[_:#/.]+/g, "-"))
      .filter(Boolean);
  }

  return {
    referencedLabelText,
    label,
    nearbyText,
    mediaName,
    hostLabel,
    iconName,
    describedText,
    rowLabel,
    hiddenControlText,
    candidateName,
    nameHint,
    countBadgeKind,
  };
}
