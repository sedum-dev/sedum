import {
  addsWords,
  iconKind,
  includesHintWord,
} from "./candidate-name-icons.js";

interface HintDependencies {
  interactive(element: Element): boolean;
  publicText(element: Element, visualOnly?: boolean, ownOnly?: boolean): string;
  role(element: Element): string;
  visible(
    element: Element,
    visualOnly?: boolean,
    ignoreOwnOpacity?: boolean,
  ): boolean;
}

interface HintNames {
  referencedLabelText(element: Element): string;
  nearbyText(element: Element): string;
  rowLabel(element: Element): string;
}

interface HintRuleContext {
  element: Element;
  name: string;
  collector: HintCollector;
  dependencies: HintDependencies;
  names: HintNames;
}

interface ClipRequest {
  readonly text: string;
  readonly limit?: number;
}

function clip({ text, limit = 48 }: ClipRequest): string {
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

export class HintCollector {
  private readonly parts: string[] = [];

  constructor(private readonly name: string) {}

  add(text: string, payload = text): void {
    if (payload && addsWords(payload, [this.name, ...this.parts].join(" ")))
      this.parts.push(text);
  }

  addLiteral(text: string): void {
    this.parts.push(text);
  }

  includes(word: string): boolean {
    return includesHintWord([this.name, ...this.parts].join(" "), word);
  }

  toString(): string {
    return this.parts.join(", ");
  }
}

function hasAuthoredFieldLabel(
  element: HTMLInputElement | HTMLTextAreaElement,
  referencedLabelText: (element: Element) => string,
  publicText: HintDependencies["publicText"],
): boolean {
  if (element.getAttribute("aria-label")?.trim()) return true;
  const referenced = element
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .some((id) => {
      const node = document.getElementById(id);
      return !!node && !!referencedLabelText(node);
    });
  if (referenced) return true;
  return Array.from(element.labels ?? []).some(
    (node) => !!publicText(node).trim(),
  );
}

function addFieldHints(context: HintRuleContext): void {
  const { element, name, collector, dependencies, names } = context;
  if (!isTextEntry(element)) return;
  const placeholder = element.getAttribute("placeholder")?.trim() ?? "";
  addPlaceholderHint(context, placeholder);
  if (!placeholder || placeholder !== name) return;
  if (
    hasAuthoredFieldLabel(
      element,
      names.referencedLabelText,
      dependencies.publicText,
    )
  )
    return;
  addCaptionHint(element, placeholder, collector, names);
}

function isTextEntry(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  );
}

function addCaptionHint(
  element: Element,
  placeholder: string,
  collector: HintCollector,
  names: HintNames,
): void {
  const caption = names.nearbyText(element) || names.rowLabel(element);
  if (caption && caption !== placeholder)
    collector.add(`label "${clip({ text: caption })}"`, caption);
}

function addPlaceholderHint(
  context: HintRuleContext,
  placeholder: string,
): void {
  if (placeholder && placeholder !== context.name)
    context.collector.add(
      `placeholder "${clip({ text: placeholder })}"`,
      placeholder,
    );
}

function addVisibleTextHints(
  element: Element,
  name: string,
  collector: HintCollector,
  publicText: HintDependencies["publicText"],
  referencedLabelText: HintNames["referencedLabelText"],
): string {
  const shown = publicText(element, true);
  const explicitlyNamed =
    element.hasAttribute("aria-label") ||
    element.hasAttribute("aria-labelledby");
  if (explicitlyNamed && shown)
    collector.add(`shows "${clip({ text: shown })}"`, shown);
  if (!/\p{L}/u.test(name)) {
    const hidden = referencedLabelText(element);
    if (/\p{L}/u.test(hidden))
      collector.add(`text "${clip({ text: hidden })}"`, hidden);
  }
  return shown;
}

function hintNodes(element: Element): Element[] {
  return Array.from(
    element.querySelectorAll("img,svg,i,span:empty,div:empty,use,kbd"),
  ).slice(0, 12);
}

function tokenValues(element: Element, nodes: Element[]): string[] {
  return [element, ...nodes].flatMap((node) => [
    node.getAttribute("class") ?? "",
    node.id,
    node.getAttribute("data-icon") ?? "",
    node === element ? "" : (node.getAttribute("title") ?? ""),
    node.matches("use") ? (node.getAttribute("href") ?? "") : "",
    node.matches("use") ? (node.getAttribute("xlink:href") ?? "") : "",
    node instanceof HTMLImageElement ? node.alt : "",
    node === element ? "" : (node.getAttribute("aria-label") ?? ""),
  ]);
}

function iconTokens(element: Element, nodes: Element[]): string[] {
  return tokenValues(element, nodes)
    .join(" ")
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[_:#/.]+/g, "-"))
    .filter(Boolean);
}

function isSiteRootLink(element: Element): boolean {
  const href = element.getAttribute("href")?.trim();
  if (!href) return false;
  if (/^(?:\/|\.\/|\/index\.html?|\/home(?:page)?\/?)$/i.test(href))
    return true;
  try {
    const url = new URL(href, location.href);
    return remoteRootMatchesSite(url);
  } catch {
    return false;
  }
}

function remoteRootMatchesSite(url: URL): boolean {
  if (url.pathname !== "/") return false;
  if (url.search) return false;
  if (url.host === location.host) return true;
  const canonical =
    document.querySelector("link[rel='canonical']")?.getAttribute("href") ??
    document.querySelector("meta[property='og:url']")?.getAttribute("content");
  return !!canonical && new URL(canonical, location.href).host === url.host;
}

function mediaLabel(media: Element[]): string {
  return (
    media
      .map((node) =>
        node instanceof HTMLImageElement
          ? node.alt
          : (node.getAttribute("aria-label") ??
            node.querySelector("title")?.textContent ??
            ""),
      )
      .map((text) => text.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? ""
  );
}

function addLogoHints(
  element: Element,
  name: string,
  media: Element[],
  collector: HintCollector,
): void {
  const label = mediaLabel(media);
  if (label) collector.add(`${clip({ text: label, limit: 32 })} logo`, label);
  if (!collector.includes("logo")) collector.addLiteral("logo");
  if (isSiteRootLink(element) && !/\bhome/i.test(name))
    collector.add("home link");
}

function keyboardText(
  element: Element,
  publicText: HintDependencies["publicText"],
): string {
  return Array.from(element.querySelectorAll("kbd"))
    .map((node) => publicText(node, true))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function addIconHints(context: HintRuleContext, shown: string): void {
  const { element, name, collector, dependencies } = context;
  const inside = hintNodes(element);
  const media = inside.filter((node) => node.matches("img,svg"));
  const tokens = iconTokens(element, inside);
  const rootLink = isRootLink(element, dependencies.role);
  const keys = keyboardText(element, dependencies.publicText);
  const keyOnly = !!keys && keys === shown;
  const iconOnly = !/\p{L}/u.test(shown) || keyOnly;
  const logo = isLogo(media, rootLink, tokens);
  if (logo) addLogoHints(element, name, media, collector);
  else if (iconOnly && hasIconEvidence(inside, name))
    addIconKind(iconKind(tokens), collector);
  if (keyOnly) collector.add("keyboard shortcut");
}

function isRootLink(element: Element, role: HintDependencies["role"]): boolean {
  const link = element.matches("a[href]") || role(element) === "link";
  return link && isSiteRootLink(element);
}

function isLogo(
  media: Element[],
  rootLink: boolean,
  tokens: string[],
): boolean {
  if (!media.length) return false;
  if (rootLink) return true;
  return tokens.some((token) => /logo|brand/.test(token));
}

function hasIconEvidence(inside: Element[], name: string): boolean {
  return !!inside.length || !/\p{L}/u.test(name);
}

function addIconKind(kind: string, collector: HintCollector): void {
  if (kind) collector.add(`${kind} icon`, kind);
}

function menuGlyph(node: Element): string {
  return (
    Array.from(node.querySelectorAll("i,span,em"))
      .flatMap((icon) => Array.from(icon.classList))
      .map(
        (token) =>
          /^(?:fa|bi|icon|mdi|ti|ri)-([a-z][a-z0-9-]*)$/.exec(token)?.[1],
      )
      .find(
        (name) => !!name && !/^(lg|[0-9]x|fw|solid|regular|light)$/.test(name),
      )
      ?.replace(/-/g, " ") ?? ""
  );
}

function addMenuHint(
  element: Element,
  collector: HintCollector,
  dependencies: HintDependencies,
  referencedLabelText: HintNames["referencedLabelText"],
): void {
  const items = Array.from(element.querySelectorAll("*"))
    .filter(
      (node) =>
        node !== element &&
        dependencies.interactive(node) &&
        !dependencies.visible(node),
    )
    .slice(0, 6)
    .map((node) =>
      [menuGlyph(node), referencedLabelText(node)].filter(Boolean).join(" "),
    )
    .filter(Boolean);
  if (items.length)
    collector.add(
      `menu "${clip({ text: items.join(", "), limit: 80 })}"`,
      items.join(" "),
    );
}

export function createNameHint(
  dependencies: HintDependencies,
  names: HintNames,
) {
  return (element: Element, name: string): string => {
    const collector = new HintCollector(name);
    const context = { element, name, collector, dependencies, names };
    addFieldHints(context);
    const shown = addVisibleTextHints(
      element,
      name,
      collector,
      dependencies.publicText,
      names.referencedLabelText,
    );
    addIconHints(context, shown);
    addMenuHint(element, collector, dependencies, names.referencedLabelText);
    return collector.toString();
  };
}
