import {
  isWeakPeer,
  NAME_LIMIT,
  PEER_LIMIT,
  type Operation,
} from "../page-protocol.js";

export interface HeadingContext {
  readonly text: string;
  readonly root: Element | null;
}

interface Heading extends HeadingContext {
  readonly level: number;
}

interface Dependencies {
  readonly document: Document;
  readonly composedParent: (element: Element) => Element | null;
  readonly allElements: (root: Element, limit: number) => Element[] | null;
  readonly visible: (element: Element) => boolean;
  readonly interactive: (element: Element) => boolean;
  readonly pointerTarget: (element: Element) => boolean;
  readonly publicText: (element: Element) => string;
  readonly excludedTextAncestor: (
    element: Element,
    strict?: boolean,
  ) => boolean;
  readonly hoverRevealed: (element: Element) => boolean;
  readonly label: (element: Element) => string;
  readonly mediaName: (element: Element) => string;
  readonly iconName: (element: Element) => string;
}

export interface PeerData {
  readonly texts: string[];
  readonly contextComplete: boolean;
  readonly item?: string;
}

const SECTIONING = "article,aside,main,nav,section";
const SECTION_TITLE_LIMIT = 60;
const CONTROL_SELECTOR =
  "button,a[href],[role='button'],input[type='button'],input[type='submit']";
const NAMED_SELECTOR = "[data-product-name],h1,h2,h3,h4,h5,h6,[role='heading']";

export function createCandidateContext(deps: Dependencies) {
  const titleCache = new Map<
    Element,
    { child: Element; text: string } | null
  >();
  const outline: Heading[] = [];

  function reset(): void {
    titleCache.clear();
    outline.length = 0;
  }

  function landmarkHint(node: Element): string {
    return `${node.id} ${typeof node.className === "string" ? node.className : ""}`.toLowerCase();
  }

  function semanticLandmark(node: Element): string {
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role");
    if (["dialog", "alertdialog"].includes(role ?? "") || tag === "dialog")
      return "dialog";
    if (role === "banner" || isTopLevelHeader(node)) return "header";
    if (role === "contentinfo" || isTopLevelFooter(node)) return "footer";
    return mappedLandmark(node);
  }

  function isTopLevelHeader(node: Element): boolean {
    if (node.tagName.toLowerCase() !== "header") return false;
    return !node.parentElement?.closest(SECTIONING);
  }

  function isTopLevelFooter(node: Element): boolean {
    if (node.tagName.toLowerCase() !== "footer") return false;
    return !node.parentElement?.closest(SECTIONING);
  }

  function mappedLandmark(node: Element): string {
    const landmarks: Readonly<Record<string, string>> = {
      navigation: "navigation",
      nav: "navigation",
      complementary: "sidebar",
      aside: "sidebar",
      main: "main",
    };
    const role = node.getAttribute("role") ?? "";
    return landmarks[role] ?? landmarks[node.tagName.toLowerCase()] ?? "";
  }

  function hintedLandmark(node: Element): string {
    const hint = landmarkHint(node);
    if (
      /(^|[\s_-])(site-?header|masthead|top-?bar|navbar|header)($|[\s_-])/.test(
        hint,
      )
    )
      return "header";
    if (/(^|[\s_-])(site-?footer|footer)($|[\s_-])/.test(hint)) return "footer";
    return /(^|[\s_-])(sidebar|side-?nav|toc|table-of-contents)($|[\s_-])/.test(
      hint,
    )
      ? "sidebar"
      : "";
  }

  function landmarkOf(node: Element): string {
    return semanticLandmark(node) || hintedLandmark(node);
  }

  function landmarkRoot(element: Element): Element | null {
    let root: Element | null = null;
    for (
      let node = deps.composedParent(element);
      node && node !== deps.document.body;
      node = deps.composedParent(node)
    )
      if (landmarkOf(node)) root = node;
    return root;
  }

  function observeHeading(element: Element): HeadingContext | null {
    if (!element.matches("h1,h2,h3,h4,h5,h6,[role='heading']")) return null;
    const text = deps.visible(element) ? deps.publicText(element) : "";
    if (!text || Array.from(text).length > 60) return null;
    const heading = {
      text,
      root: landmarkRoot(element),
      level: headingLevel(element),
    };
    while (
      outline.length &&
      outline[outline.length - 1]!.level >= heading.level
    )
      outline.pop();
    outline.push(heading);
    return heading;
  }

  function headingLevel(element: Element): number {
    return (
      Number(
        /^h([1-6])$/i.exec(element.tagName)?.[1] ??
          element.getAttribute("aria-level"),
      ) || 2
    );
  }

  function locationOf(element: Element, heading: HeadingContext): string {
    const marks: string[] = [];
    let root: Element | null = null;
    for (
      let node = deps.composedParent(element);
      node && node !== deps.document.body;
      node = deps.composedParent(node)
    ) {
      const mark = landmarkOf(node);
      if (!mark) continue;
      root = node;
      if (!marks.includes(mark)) marks.unshift(mark);
    }
    const kept =
      marks.length > 2 ? [marks[0]!, marks[marks.length - 1]!] : marks;
    const parts = [
      kept.join(", "),
      heading.root === root ? heading.text : "",
    ].filter(Boolean);
    return Array.from(parts.join(" · ")).slice(0, PEER_LIMIT).join("");
  }

  function shortText(element: Element): string {
    if ((element.textContent ?? "").length > 400) return "";
    const text = deps.publicText(element);
    return Array.from(text).length <= SECTION_TITLE_LIMIT ? text : "";
  }

  function validTitleChild(child: Element): boolean {
    if (child.matches("li,tr,option,[role='listitem'],[role='row']"))
      return false;
    const controls = child.querySelectorAll(
      "button,a[href],input,select,textarea,[role='button'],[role='link']",
    ).length;
    return deps.interactive(child) ? controls === 0 : controls <= 1;
  }

  function titleFromChild(
    child: Element,
  ): { child: Element; text: string } | null {
    if (!validTitleChild(child)) return null;
    const heading = child.matches("h1,h2,h3,h4,h5,h6,[role='heading']")
      ? child
      : child.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']");
    const text = shortText(heading ?? child);
    return text && text.split(/\s+/).length <= 8 && !/^skip to\b/i.test(text)
      ? { child, text }
      : null;
  }

  function containerTitle(
    container: Element,
  ): { child: Element; text: string } | null {
    if (titleCache.has(container)) return titleCache.get(container)!;
    const child = Array.from(container.children).find(
      (item) => !!(item.textContent ?? "").trim() && deps.visible(item),
    );
    const found = child ? titleFromChild(child) : null;
    titleCache.set(container, found);
    return found;
  }

  function addLabel(labels: string[], text: string): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!validSectionLabel(labels, clean)) return;
    labels.push(clean);
  }

  function validSectionLabel(labels: string[], text: string): boolean {
    if (!text || Array.from(text).length > SECTION_TITLE_LIMIT) return false;
    return !labels.includes(text);
  }

  function ariaLabel(node: Element, element: Element): string {
    const direct = node.getAttribute("aria-label");
    if (direct) return direct;
    return (node.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => deps.document.getElementById(id))
      .map((target) =>
        target && target !== element ? deps.publicText(target) : "",
      )
      .join(" ");
  }

  function ownTitle(node: Element, child: Element): string {
    const selectors = [
      ["fieldset", "legend"],
      ["table", "caption"],
      ["figure", "figcaption"],
      ["details", "summary"],
    ];
    const match = selectors.find(([container]) => node.matches(container!));
    const title =
      match &&
      Array.from(node.children).find((item) => item.matches(match[1]!));
    return title && title !== child ? shortText(title) : "";
  }

  function collectSectionLabels(element: Element): string[] {
    const labels: string[] = [];
    let child = element;
    let node = deps.composedParent(element);
    for (
      let depth = 0;
      node && node !== deps.document.body && depth < 30 && labels.length < 6;
      depth++
    ) {
      collectNodeLabels(labels, node, child, element);
      child = node;
      node = deps.composedParent(node);
    }
    return labels;
  }

  function collectNodeLabels(
    labels: string[],
    node: Element,
    child: Element,
    element: Element,
  ): void {
    if (!deps.interactive(node)) addLabel(labels, ariaLabel(node, element));
    addLabel(labels, ownTitle(node, child));
    const title = containerTitle(node);
    if (!titleApplies(title, child, element)) return;
    addLabel(labels, title.text);
  }

  function titleApplies(
    title: { child: Element; text: string } | null,
    child: Element,
    element: Element,
  ): title is { child: Element; text: string } {
    if (!title || title.child === child) return false;
    return !title.child.contains(element);
  }

  function sectionOf(element: Element): string {
    const labels = collectSectionLabels(element);
    const root = landmarkRoot(element);
    for (let index = outline.length - 1; index >= 0; index--)
      if (outline[index]!.root === root) addLabel(labels, outline[index]!.text);
    return Array.from(labels.slice(0, 6).join(" › ")).slice(0, 300).join("");
  }

  function boundedName(name: string): string {
    const points = Array.from(name);
    return points.length <= NAME_LIMIT
      ? name
      : points.slice(0, NAME_LIMIT - 1).join("") + "…";
  }

  function path(element: Element): string {
    const steps: string[] = [];
    for (
      let node: Element | null = element;
      node && steps.length < 12;
      node = node.parentElement
    ) {
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(
            (child) => child.tagName === node!.tagName,
          )
        : [node];
      steps.unshift(`${node.tagName.toLowerCase()}:${siblings.indexOf(node)}`);
    }
    return steps.join("/");
  }

  function inArticleBody(element: Element): boolean {
    return (
      !!element.closest("main,article,[role='main']") &&
      !element.closest("aside,nav,table,[role='navigation'],.infobox,.navbox")
    );
  }

  function itemContext(region: Element): { text: string; complete: boolean } {
    const walker = deps.document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    let length = 0;
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!usableTextParent(parent)) continue;
      const part = (walker.currentNode.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!part) continue;
      length += Array.from(part).length + (pieces.length ? 1 : 0);
      if (length > PEER_LIMIT) return { text: "", complete: false };
      pieces.push(part);
    }
    return { text: pieces.join(" "), complete: true };
  }

  function usableTextParent(parent: Element | null): parent is Element {
    if (!parent || !deps.visible(parent)) return false;
    return !deps.excludedTextAncestor(parent, true);
  }

  function rankedPeer(element: Element): string {
    const preceding = element.closest("tr")?.previousElementSibling;
    const rank = preceding?.querySelector(".rank");
    const title = preceding?.querySelector(".titleline > a");
    if (!rank || !title) return "";
    return Array.from(
      `${deps.publicText(rank)} ${deps.publicText(title)}`.trim(),
    )
      .slice(0, PEER_LIMIT)
      .join("");
  }

  function hasRepeatedCard(region: Element): boolean {
    if (!region.classList.length) return false;
    return Array.from(region.parentElement?.children ?? []).some(
      (sibling) =>
        sibling !== region &&
        sibling.tagName === region.tagName &&
        sibling.classList.length === region.classList.length &&
        Array.from(region.classList).every((name) =>
          sibling.classList.contains(name),
        ),
    );
  }

  function sameNamedCount(possible: Element[], name: string): number {
    return possible.filter((item) => isSameNamedControl(item, name)).length;
  }

  function isSameNamedControl(item: Element, name: string): boolean {
    if (!deps.visible(item) && !deps.hoverRevealed(item)) return false;
    return (
      (deps.label(item) || deps.mediaName(item) || deps.iconName(item)) === name
    );
  }

  function controlsIn(region: Element): Element[] | null {
    const scope = deps.allElements(region, 2000);
    if (!scope) return null;
    return scope.filter((item) => item.matches(CONTROL_SELECTOR));
  }

  function exceedsPeerScope(possible: Element[] | null, name: string): boolean {
    if (!possible || possible.length > 32) return true;
    return sameNamedCount(possible, name) > 1;
  }

  function isItemBoundary(region: Element, operation: Operation): boolean {
    if (region.matches("article,li,[data-product],[role='listitem']"))
      return true;
    if (operation === "click") return deps.pointerTarget(region);
    return operation === "read" && hasRepeatedCard(region);
  }

  function findPeerRegion(
    element: Element,
    name: string,
    operation: Operation,
  ): Element | null {
    let region = deps.composedParent(element);
    let lastUnique: Element | null = null;
    while (region && region !== deps.document.body) {
      if (exceedsPeerScope(controlsIn(region), name)) return lastUnique;
      lastUnique = region;
      if (isItemBoundary(region, operation)) break;
      region = deps.composedParent(region);
    }
    return region === deps.document.body ? lastUnique : region;
  }

  function peerChildren(region: Element): Element[] {
    const named = Array.from(region.querySelectorAll(NAMED_SELECTOR));
    const leaves = Array.from(region.querySelectorAll("div,span,strong,p"))
      .filter(
        (child) =>
          child.children.length === 0 && !isWeakPeer(deps.publicText(child)),
      )
      .sort(
        (a, b) => Number(b.tagName === "DIV") - Number(a.tagName === "DIV"),
      );
    return [
      ...named,
      ...leaves,
      ...Array.from(region.querySelectorAll("strong,span,p")),
    ];
  }

  function appendPeerTexts(
    result: string[],
    region: Element,
    element: Element,
    name: string,
  ): void {
    for (const child of peerChildren(region)) {
      if (result.length === 2) break;
      if (!usablePeerChild(child, element)) continue;
      const text = Array.from(deps.publicText(child))
        .slice(0, PEER_LIMIT)
        .join("");
      if (newPeerText(result, text, name)) result.push(text);
    }
  }

  function usablePeerChild(child: Element, element: Element): boolean {
    if (child === element || child.contains(element)) return false;
    if (element.contains(child)) return false;
    return deps.visible(child);
  }

  function newPeerText(result: string[], text: string, name: string): boolean {
    if (!text || text === name) return false;
    return !result.includes(text);
  }

  function itemText(region: Element, ranked: string): string {
    const text = `${ranked} ${deps.publicText(region)}`
      .replace(/\s+/g, " ")
      .trim();
    return Array.from(text).slice(0, 300).join("");
  }

  function peerResult(
    texts: string[],
    context: { text: string; complete: boolean },
    ranked: string,
    item: string,
  ): PeerData {
    const result: PeerData = {
      texts,
      contextComplete: !ranked && context.complete && !!context.text,
    };
    return item && (context.text || ranked) ? { ...result, item } : result;
  }

  function peers(
    element: Element,
    name: string,
    operation: Operation = "click",
  ): PeerData {
    const ranked = rankedPeer(element);
    const region = findPeerRegion(element, name, operation);
    if (!region)
      return { texts: ranked ? [ranked] : [], contextComplete: false };
    const result: string[] = ranked ? [ranked] : [];
    const item = itemText(region, ranked);
    const context = itemContext(region);
    if (context.text && result.length < 2) result.push(context.text);
    appendPeerTexts(result, region, element, name);
    return peerResult(result, context, ranked, item);
  }

  return {
    reset,
    observeHeading,
    locationOf,
    sectionOf,
    boundedName,
    path,
    inArticleBody,
    peers,
  };
}
