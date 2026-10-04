type HoverProperty = "display" | "visibility" | "opacity";

type CascadeRule = {
  readonly selector: string;
  readonly match: string;
  readonly specificity: readonly [number, number, number] | null;
  readonly order: number;
  readonly style: CSSStyleDeclaration;
};

type HoverRule = CascadeRule & {
  readonly revealed: string;
  readonly host: string;
  readonly display: boolean;
  readonly visibility: boolean;
  readonly opacity: boolean;
};

type RevealPlan = {
  readonly display: Set<Element>;
  visibility: boolean;
  opacity: boolean;
};

type RevealedProperties = Pick<HoverRule, "display" | "visibility" | "opacity">;

const DEPTH_CHANGES: Readonly<Record<string, number>> = {
  "(": 1,
  "[": 1,
  ")": -1,
  "]": -1,
};

type HoverDependencies = {
  composedParent(element: Element): Element | null;
  interactive(element: Element): boolean;
  visible(element: Element): boolean;
};

export type HoverDiscovery = {
  reset(): void;
  host(element: Element): Element | null;
  revealed(element: Element): boolean;
};

function selectorList(text: string): string[] {
  return new SelectorListParser(text).parse();
}

class SelectorListParser {
  private readonly selectors: string[] = [];
  private start = 0;
  private depth = 0;
  private quote = "";

  constructor(private readonly text: string) {}

  parse(): string[] {
    for (let index = 0; index < this.text.length; index++) {
      this.consume(this.text[index]!, index);
    }
    this.push(this.text.length);
    return this.selectors.filter(Boolean);
  }

  private consume(char: string, index: number): void {
    if (this.quote) {
      if (char === this.quote && this.text[index - 1] !== "\\") this.quote = "";
      return;
    }
    const depthChange = DEPTH_CHANGES[char];
    if (depthChange) {
      this.depth += depthChange;
      return;
    }
    if (/['"]/.test(char)) {
      this.quote = char;
      return;
    }
    if (char === "," && this.depth === 0) this.push(index);
  }

  private push(end: number): void {
    this.selectors.push(this.text.slice(this.start, end).trim());
    this.start = end + 1;
  }
}

/** Specificity for the deliberately small selector subset we can prove. */
function specificity(
  selector: string,
): readonly [number, number, number] | null {
  // Functional pseudo-classes, escapes, namespaces and pseudo-elements have
  // nontrivial specificity. Refuse them rather than guessing actionability.
  if (/\\|\||::|:[\w-]+\(/.test(selector)) return null;
  const attributes = selector.match(/\[[^\]]*\]/g)?.length ?? 0;
  const bare = selector.replace(/\[[^\]]*\]/g, " ");
  const ids = bare.match(/#[\w-]+/g)?.length ?? 0;
  const classes = bare.match(/\.[\w-]+/g)?.length ?? 0;
  const pseudos = bare.match(/:(?!:)[\w-]+/g)?.length ?? 0;
  const withoutQualifiers = bare
    .replace(/#[\w-]+|\.[\w-]+|:(?!:)[\w-]+/g, "")
    .replace(/\*/g, "");
  const types =
    withoutQualifiers.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g)?.length ?? 0;
  return [ids, attributes + classes + pseudos, types];
}

function stronger(a: CascadeRule, b: CascadeRule, property: HoverProperty) {
  const importantA = a.style.getPropertyPriority(property) === "important";
  const importantB = b.style.getPropertyPriority(property) === "important";
  if (importantA !== importantB) return importantA;
  if (!a.specificity || !b.specificity) return false;
  for (let index = 0; index < 3; index++) {
    if (a.specificity[index] !== b.specificity[index])
      return a.specificity[index]! > b.specificity[index]!;
  }
  return a.order > b.order;
}

function hoverWins(
  element: Element,
  property: HoverProperty,
  reveal: HoverRule,
  cascadeRules: readonly CascadeRule[],
): boolean {
  let winner: CascadeRule | null = null;
  for (const rule of cascadeRules) {
    const applies = ruleApplies(element, property, rule);
    if (applies === null) return false;
    if (!applies) continue;
    if (!winner || stronger(rule, winner, property)) winner = rule;
  }
  return winnerMatchesReveal(winner, reveal);
}

function winnerMatchesReveal(
  winner: CascadeRule | null,
  reveal: HoverRule,
): boolean {
  if (winner?.order !== reveal.order) return false;
  return winner.selector === reveal.selector;
}

function ruleApplies(
  element: Element,
  property: HoverProperty,
  rule: CascadeRule,
): boolean | null {
  if (!rule.style.getPropertyValue(property)) return false;
  const matches = safelyMatches(element, rule.match);
  if (matches === null) return null;
  if (matches && !rule.specificity) return null;
  return matches;
}

function safelyMatches(element: Element, selector: string): boolean | null {
  try {
    return element.matches(selector);
  } catch {
    return null;
  }
}

class StylesheetReader {
  readonly hoverRules: HoverRule[] = [];
  readonly declarations: CascadeRule[] = [];
  complete = true;
  private order = 0;

  read(): readonly HoverRule[] {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        this.visit(sheet.cssRules, true);
      } catch {
        this.complete = false;
      }
    }
    return this.complete ? this.hoverRules : [];
  }

  private visit(list: CSSRuleList, safe: boolean): void {
    for (const rule of Array.from(list)) this.visitRule(rule, safe);
  }

  private visitRule(rule: CSSRule, safe: boolean): void {
    if (rule instanceof CSSStyleRule) this.visitStyle(rule, safe);
    else if (rule instanceof CSSImportRule) this.visitImport(rule, safe);
    else if ("cssRules" in rule) this.visitGroup(rule, safe);
  }

  private visitStyle(rule: CSSStyleRule, safe: boolean): void {
    const style = rule.style;
    const properties = revealedProperties(style);
    for (const selector of selectorList(rule.selectorText)) {
      const declaration = this.createDeclaration(selector, style, safe);
      if (!declaration) continue;
      this.declarations.push(declaration);
      if (!canReveal(safe, declaration, properties)) continue;
      const hoverRule = createHoverRule(declaration, properties);
      if (hoverRule) this.hoverRules.push(hoverRule);
    }
  }

  private createDeclaration(
    selector: string,
    style: CSSStyleDeclaration,
    safe: boolean,
  ): CascadeRule | null {
    const match = selector.replace(/:hover/g, "").trim();
    const declaration = {
      selector,
      match,
      specificity: safe ? specificity(selector) : null,
      order: ++this.order,
      style,
    };
    try {
      document.querySelector(match);
      return declaration;
    } catch {
      return null;
    }
  }

  private visitImport(rule: CSSImportRule, safe: boolean): void {
    try {
      if (rule.styleSheet) this.visit(rule.styleSheet.cssRules, safe);
      else this.complete = false;
    } catch {
      this.complete = false;
    }
  }

  private visitGroup(rule: CSSRule, safe: boolean): void {
    const name = rule.constructor.name;
    if (!groupApplies(rule, name)) return;
    const unsafe = [
      "CSSLayerBlockRule",
      "CSSScopeRule",
      "CSSContainerRule",
    ].includes(name);
    this.visit((rule as CSSGroupingRule).cssRules, safe && !unsafe);
  }
}

function revealedProperties(style: CSSStyleDeclaration): RevealedProperties {
  return {
    display: style.display !== "" && style.display !== "none",
    visibility: style.visibility === "visible",
    opacity: style.opacity !== "" && Number.parseFloat(style.opacity) > 0,
  };
}

function reveals({
  display,
  visibility,
  opacity,
}: RevealedProperties): boolean {
  return display || visibility || opacity;
}

function canReveal(
  safe: boolean,
  declaration: CascadeRule,
  properties: RevealedProperties,
): boolean {
  return safe && declaration.specificity !== null && reveals(properties);
}

function groupApplies(rule: CSSRule, name: string): boolean {
  if (name === "CSSMediaRule")
    return matchMedia((rule as CSSMediaRule).conditionText).matches;
  if (name === "CSSSupportsRule")
    return CSS.supports((rule as CSSSupportsRule).conditionText);
  return true;
}

function createHoverRule(
  declaration: CascadeRule,
  properties: RevealedProperties,
): HoverRule | null {
  const { selector, match: revealed } = declaration;
  if (!selector.includes(":hover")) return null;
  const at = selector.lastIndexOf(":hover");
  const host = selector
    .slice(0, at)
    .replace(/:hover/g, "")
    .trim();
  if (!host || host === revealed) return null;
  try {
    document.querySelector(host);
    return { ...declaration, revealed, host, ...properties };
  } catch {
    return null;
  }
}

function elementPath(
  element: Element,
  composedParent: HoverDependencies["composedParent"],
  interactive: HoverDependencies["interactive"],
): Element[] | null {
  const path: Element[] = [];
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = composedParent(node)
  ) {
    path.push(node);
    if (node !== element && interactive(node)) return null;
  }
  return path;
}

function pathCanBeRevealed(path: Element[], plan: RevealPlan): boolean {
  return path.every((node) => nodeCanBeRevealed(node, plan));
}

function nodeCanBeRevealed(node: Element, plan: RevealPlan): boolean {
  const style = getComputedStyle(node);
  if (style.contentVisibility === "hidden" || inlineHidden(node)) return false;
  if (style.display === "none" && !plan.display.has(node)) return false;
  if (computedVisibilityHidden(style) && !plan.visibility) return false;
  return Number.parseFloat(style.opacity) !== 0 || plan.opacity;
}

function inlineHidden(node: Element): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node.style.display === "none" ||
    node.style.visibility === "hidden" ||
    Number.parseFloat(node.style.opacity) === 0
  );
}

function computedVisibilityHidden(style: CSSStyleDeclaration): boolean {
  return style.visibility === "hidden" || style.visibility === "collapse";
}

function revealPlans(
  path: readonly Element[],
  hoverRules: readonly HoverRule[],
  cascadeRules: readonly CascadeRule[],
  composedParent: HoverDependencies["composedParent"],
  visible: HoverDependencies["visible"],
): Map<Element, RevealPlan> {
  const plans = new Map<Element, RevealPlan>();
  for (const node of path) {
    for (const rule of hoverRules) {
      if (!node.matches(rule.revealed)) continue;
      const hoverHost = matchingHost(node, rule.host, composedParent);
      if (!hoverHost || !visible(hoverHost)) continue;
      const plan = plans.get(hoverHost) ?? {
        display: new Set<Element>(),
        visibility: false,
        opacity: false,
      };
      if (rule.display && hoverWins(node, "display", rule, cascadeRules))
        plan.display.add(node);
      plan.visibility ||=
        rule.visibility && hoverWins(node, "visibility", rule, cascadeRules);
      plan.opacity ||=
        rule.opacity && hoverWins(node, "opacity", rule, cascadeRules);
      plans.set(hoverHost, plan);
    }
  }
  return plans;
}

function matchingHost(
  node: Element,
  selector: string,
  composedParent: HoverDependencies["composedParent"],
): Element | null {
  let host: Element | null = node;
  while (host && !host.matches(selector)) host = composedParent(host);
  return host;
}

export function createHoverDiscovery({
  composedParent,
  interactive,
  visible,
}: HoverDependencies): HoverDiscovery {
  let hoverRules: readonly HoverRule[] | undefined;
  let cascadeRules: readonly CascadeRule[] = [];

  function readHoverRules(): readonly HoverRule[] {
    const reader = new StylesheetReader();
    const rules = reader.read();
    cascadeRules = reader.complete ? reader.declarations : [];
    return rules;
  }

  function host(element: Element): Element | null {
    if (!interactive(element)) return null;
    if (element.closest("[hidden],[inert],[aria-hidden='true']")) return null;
    hoverRules ??= readHoverRules();
    const path = elementPath(element, composedParent, interactive);
    if (!path) return null;
    const plans = revealPlans(
      path,
      hoverRules,
      cascadeRules,
      composedParent,
      visible,
    );
    return (
      Array.from(plans)
        .filter(([hoverHost, plan]) =>
          pathCanBeRevealed(path.slice(0, path.indexOf(hoverHost) + 1), plan),
        )
        .map(([hoverHost]) => hoverHost)
        .sort((a, b) => path.indexOf(a) - path.indexOf(b))[0] ?? null
    );
  }

  return {
    reset: () => {
      hoverRules = undefined;
    },
    host,
    revealed: (element) => !visible(element) && !!host(element),
  };
}
