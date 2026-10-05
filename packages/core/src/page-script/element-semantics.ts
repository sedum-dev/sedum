import { isSafeRole } from "../page-protocol.js";

interface Dependencies {
  readonly document: Document;
  readonly modalOrder: Map<HTMLDialogElement, number>;
  readonly composedParent: (element: Element) => Element | null;
  readonly allElements: (root: Element, limit: number) => Element[] | null;
  readonly flatTextNodes: (root: Node) => Text[];
}

const FILLABLE_INPUT_TYPES = new Set([
  "text",
  "email",
  "password",
  "search",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);
const TEXT_FIELD_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
]);

export function createElementSemantics(deps: Dependencies) {
  function hiddenSelector(visualOnly: boolean): string {
    return visualOnly
      ? "[hidden],[inert],dialog:not([open])"
      : "[hidden],[inert],[aria-hidden='true'],dialog:not([open])";
  }

  function outsideViewport(element: Element): boolean {
    const bounds = element.getBoundingClientRect();
    return outsideHorizontally(bounds) || outsideVertically(bounds);
  }

  function outsideHorizontally(bounds: DOMRect): boolean {
    return bounds.right <= 0 || bounds.left >= innerWidth;
  }

  function outsideVertically(bounds: DOMRect): boolean {
    return bounds.bottom <= 0 || bounds.top >= innerHeight;
  }

  function hiddenAcrossShadowBoundary(
    node: Element,
    origin: Element,
    visualOnly: boolean,
  ): boolean {
    if (node.getRootNode() === origin.getRootNode()) return false;
    return node.matches(
      visualOnly ? "[hidden],[inert]" : "[hidden],[inert],[aria-hidden='true']",
    );
  }

  function hiddenByStyle(
    node: Element,
    origin: Element,
    ignoreOwnOpacity: boolean,
  ): boolean {
    const style = getComputedStyle(node);
    if (style.contentVisibility === "hidden") return true;
    return opacityHidden(style, node === origin, ignoreOwnOpacity);
  }

  function opacityHidden(
    style: CSSStyleDeclaration,
    own: boolean,
    ignoreOwnOpacity: boolean,
  ): boolean {
    if (Number.parseFloat(style.opacity) !== 0) return false;
    return !own || !ignoreOwnOpacity;
  }

  function hiddenAncestor(
    element: Element,
    visualOnly: boolean,
    ignoreOwnOpacity: boolean,
  ): boolean {
    for (
      let node: Element | null = element;
      node;
      node = deps.composedParent(node)
    ) {
      if (hiddenAcrossShadowBoundary(node, element, visualOnly)) return true;
      if (hiddenByStyle(node, element, ignoreOwnOpacity)) return true;
    }
    return false;
  }

  function contentsVisible(element: Element): boolean {
    const range = deps.document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).some(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  }

  function visible(
    element: Element,
    visualOnly = false,
    ignoreOwnOpacity = false,
  ): boolean {
    if (element.closest(hiddenSelector(visualOnly))) return false;
    const dialog = element.closest("dialog,[role='dialog']");
    if (dialog && outsideViewport(dialog)) return false;
    if (hiddenAncestor(element, visualOnly, ignoreOwnOpacity)) return false;
    return rendered(element);
  }

  function rendered(element: Element): boolean {
    const style = getComputedStyle(element);
    if (style.display === "none") return false;
    if (["hidden", "collapse"].includes(style.visibility)) return false;
    if (element.getClientRects().length > 0) return true;
    return style.display === "contents" && contentsVisible(element);
  }

  function cleanModalOrder(): void {
    for (const dialog of deps.modalOrder.keys())
      if (!dialog.isConnected || !dialog.open) deps.modalOrder.delete(dialog);
  }

  function newestNative(
    dialogs: HTMLDialogElement[],
  ): HTMLDialogElement | undefined {
    const ordered = [...dialogs].sort(
      (a, b) => (deps.modalOrder.get(b) ?? 0) - (deps.modalOrder.get(a) ?? 0),
    );
    return (deps.modalOrder.get(ordered[0]!) ?? 0) > 0 ? ordered[0] : undefined;
  }

  function selectedNative(dialogs: HTMLDialogElement[]): Element | undefined {
    const newest = newestNative(dialogs);
    if (newest) return newest;
    return (
      dialogs.find((element) =>
        element.contains(deps.document.activeElement),
      ) ?? (dialogs.length === 1 ? dialogs[0] : undefined)
    );
  }

  function modal(): Element | null | undefined {
    cleanModalOrder();
    const dialogs = Array.from(
      deps.document.querySelectorAll(
        "dialog:modal,[role='dialog'][aria-modal='true']",
      ),
    ).filter((element) => visible(element));
    if (!dialogs.length) return null;
    const native = dialogs.filter((element): element is HTMLDialogElement =>
      element.matches("dialog:modal"),
    );
    return native.length
      ? selectedNative(native)
      : dialogs.length === 1
        ? dialogs[0]
        : undefined;
  }

  function inputRole(element: HTMLInputElement): string {
    if (["button", "submit", "reset", "file"].includes(element.type))
      return "button";
    const mapped: Record<string, string> = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      number: "spinbutton",
      search: "searchbox",
    };
    return mapped[element.type] ?? "textbox";
  }

  function role(element: Element): string {
    const canonical = element
      .getAttribute("role")
      ?.split(/\s+/)
      .find(isSafeRole);
    if (canonical) return canonical;
    return implicitRole(element);
  }

  function implicitRole(element: Element): string {
    if (element instanceof HTMLButtonElement) return "button";
    if (element.matches("details > summary")) return "button";
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLInputElement) return inputRole(element);
    if (element instanceof HTMLTextAreaElement) return "textbox";
    return element instanceof HTMLSelectElement ? "combobox" : "";
  }

  function interactive(element: Element): boolean {
    if (element.parentElement?.closest("a[href]")) return false;
    if (
      element.matches(
        "button,a[href],input,textarea,select,[contenteditable],details > summary",
      )
    )
      return true;
    return INTERACTIVE_ROLES.has(role(element));
  }

  function excludedTextAncestor(
    element: Element,
    includeActions = false,
  ): boolean {
    for (let node: Element | null = element; node; node = node.parentElement)
      if (excludedTextNode(node, includeActions)) return true;
    return false;
  }

  function excludedTextNode(node: Element, includeActions: boolean): boolean {
    if (
      node.matches(
        "input,textarea,select,[contenteditable],script,style,noscript",
      )
    )
      return true;
    if (TEXT_FIELD_ROLES.has(role(node))) return true;
    return (
      includeActions &&
      (node.matches("button,a[href]") ||
        ["button", "link"].includes(role(node)))
    );
  }

  function insideNestedControl(element: Element, node: Element): boolean {
    for (
      let current: Element | null = node;
      current && current !== element;
      current = deps.composedParent(current)
    )
      if (interactive(current)) return true;
    return false;
  }

  function publicText(
    element: Element,
    visualOnly = false,
    ownOnly = false,
  ): string {
    const parts: string[] = [];
    for (const node of deps.flatTextNodes(element)) {
      const parent = node.parentElement;
      if (!eligibleTextParent(parent, visualOnly)) continue;
      if (!ownOnly || !insideNestedControl(element, parent))
        parts.push(node.textContent ?? "");
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function eligibleTextParent(
    parent: HTMLElement | null,
    visualOnly: boolean,
  ): parent is HTMLElement {
    if (!parent) return false;
    if (!visible(parent, visualOnly)) return false;
    return !excludedTextAncestor(parent);
  }

  function clippedAway(element: Element): boolean {
    const box = element.getBoundingClientRect();
    const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    for (
      let node = deps.composedParent(element);
      node && node !== deps.document.body;
      node = deps.composedParent(node)
    )
      if (clipsPoint(node, point)) return true;
    return false;
  }

  function clipsPoint(node: Element, point: { x: number; y: number }): boolean {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible")
      return false;
    const bounds = node.getBoundingClientRect();
    return (
      point.x < bounds.left ||
      point.x > bounds.right ||
      point.y < bounds.top ||
      point.y > bounds.bottom
    );
  }

  function ariaHiddenOnly(element: Element): boolean {
    if (!interactive(element)) return false;
    if (visible(element)) return false;
    if (!visible(element, true)) return false;
    const box = element.getBoundingClientRect();
    return (
      box.width >= 8 &&
      box.height >= 8 &&
      !clippedAway(element) &&
      !!publicText(element, true)
    );
  }

  function isToggle(element: Element): element is HTMLInputElement {
    return (
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type)
    );
  }

  function transparentToggle(element: Element): boolean {
    if (!isToggle(element) || visible(element)) return false;
    const box = element.getBoundingClientRect();
    return box.width >= 8 && box.height >= 8 && visible(element, false, true);
  }

  function toggleLabel(element: Element): HTMLInputElement | null {
    if (!(element instanceof HTMLLabelElement)) return null;
    const control = element.control;
    if (!control) return null;
    if (!isToggle(control)) return null;
    if (visible(control)) return null;
    if (transparentToggle(control)) return null;
    if (control.labels?.[0] !== element) return null;
    return control;
  }

  function pointerTarget(element: Element): boolean {
    if (!pointerCandidate(element) || insideInteractiveAncestor(element))
      return false;
    const inside = deps.allElements(element, 500);
    if (!inside) return false;
    const controls = inside.filter(
      (node) => interactive(node) || node.hasAttribute("role"),
    );
    if (!controls.length) return true;
    return (
      controls.every(
        (control) => !interactive(control) || !publicText(control, true),
      ) && !!publicText(element, false, true)
    );
  }

  function pointerCandidate(element: Element): boolean {
    if (interactive(element) || element.matches("html,body,label,svg *"))
      return false;
    if (getComputedStyle(element).cursor !== "pointer") return false;
    const parent = deps.composedParent(element);
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  function insideInteractiveAncestor(element: Element): boolean {
    for (
      let node = deps.composedParent(element);
      node;
      node = deps.composedParent(node)
    )
      if (interactive(node)) return true;
    return false;
  }

  function disabled(element: Element): boolean {
    return (
      element.matches(":disabled,[aria-disabled='true']") ||
      !!element.closest("[inert]")
    );
  }

  function editable(element: Element): boolean {
    if (element instanceof HTMLInputElement)
      return FILLABLE_INPUT_TYPES.has(element.type) && !disabled(element);
    if (element instanceof HTMLTextAreaElement) return !disabled(element);
    return (
      element instanceof HTMLElement &&
      element.isContentEditable &&
      !disabled(element)
    );
  }

  function readable(element: Element): boolean {
    if (interactive(element) || excludedTextAncestor(element, true))
      return false;
    if (
      element.matches("h1,h2,h3,h4,h5,h6,p,blockquote,td,th,[role='heading']")
    )
      return true;
    return (
      element.children.length === 0 &&
      element.matches("span,strong,em,div,li") &&
      publicText(element).length > 0
    );
  }

  return {
    visible,
    modal,
    role,
    interactive,
    excludedTextAncestor,
    publicText,
    insideNestedControl,
    ariaHiddenOnly,
    isToggle,
    transparentToggle,
    toggleLabel,
    pointerTarget,
    disabled,
    editable,
    readable,
  };
}
