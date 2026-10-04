interface SpatialDependencies {
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
  visible(
    element: Element,
    visualOnly?: boolean,
    ignoreOwnOpacity?: boolean,
  ): boolean;
}

interface TextPosition {
  text: string;
  rect: DOMRect;
}

interface Match {
  text: string;
  distance: number;
}

interface TextSearch {
  element: Element;
  root: Element;
  box: DOMRect;
  distanceFor(box: DOMRect, rect: DOMRect): number;
  limit: number;
  excludeLabels: boolean;
}

function normalizedText(node: Text): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function textRect(node: Text): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}

function visibleRect(rect: DOMRect): boolean {
  return !!rect.width && !!rect.height;
}

function lineAligned(first: DOMRect, second: DOMRect): boolean {
  const firstMiddle = first.top + first.height / 2;
  const secondMiddle = second.top + second.height / 2;
  return (
    Math.abs(firstMiddle - secondMiddle) <
    Math.max(first.height, second.height) / 2
  );
}

function nearbyDistance(box: DOMRect, rect: DOMRect): number {
  if (lineAligned(box, rect)) return horizontalDistance(box, rect);
  const overlapsColumn = rect.left < box.right && rect.right > box.left;
  if (overlapsColumn && rect.bottom <= box.top + 2)
    return box.top - rect.bottom;
  return Infinity;
}

function horizontalDistance(box: DOMRect, rect: DOMRect): number {
  if (rect.left >= box.right - 2) return rect.left - box.right;
  if (rect.right <= box.left + 2) return box.left - rect.right;
  return Infinity;
}

function rowDistance(box: DOMRect, rect: DOMRect): number {
  if (lineAligned(box, rect)) return horizontalDistance(box, rect);
  if (rect.bottom <= box.top + 2 && rect.left < box.right)
    return box.top - rect.bottom;
  return Infinity;
}

function closer(best: Match | null, candidate: Match): Match {
  return !best || candidate.distance < best.distance ? candidate : best;
}

export function createSpatialNames(dependencies: SpatialDependencies) {
  const {
    allElements,
    composedParent,
    deepContains,
    excludedTextAncestor,
    flatTextNodes,
    interactive,
    visible,
  } = dependencies;

  function unavailableParent(element: Element, parent: Element): boolean {
    if (deepContains(element, parent)) return true;
    if (excludedTextAncestor(parent, true)) return true;
    return !visible(parent);
  }

  function eligibleText(
    element: Element,
    node: Text,
    excludeLabels: boolean,
  ): TextPosition | null {
    const parent = node.parentElement;
    const text = normalizedText(node);
    if (!parent || !text) return null;
    if (unavailableParent(element, parent)) return null;
    const labelsControl = (parent.closest("label") as HTMLLabelElement | null)
      ?.control;
    if (excludeLabels && labelsControl) return null;
    const rect = textRect(node);
    return visibleRect(rect) ? { text, rect } : null;
  }

  function bestText(search: TextSearch): Match | null {
    let best: Match | null = null;
    for (const node of flatTextNodes(search.root)) {
      const position = eligibleText(search.element, node, search.excludeLabels);
      if (!position) continue;
      const distance = search.distanceFor(search.box, position.rect);
      if (distance <= search.limit)
        best = closer(best, { text: position.text, distance });
    }
    return best;
  }

  function nearbyText(element: Element): string {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return "";
    let scope = composedParent(element);
    for (let level = 0; scope && level < 3; level++) {
      const best = bestText({
        element,
        root: scope,
        box,
        distanceFor: nearbyDistance,
        limit: 48,
        excludeLabels: true,
      });
      if (best) return best.text;
      scope = composedParent(scope);
    }
    return "";
  }

  function rowContainer(element: Element): Element | null {
    let row: Element | null = null;
    let node = composedParent(element);
    for (let level = 0; node && node !== document.body && level < 7; level++) {
      const inside = allElements(node, 400);
      if (!inside) break;
      const otherControl = inside.some(
        (other) => other !== element && interactive(other) && visible(other),
      );
      if (otherControl) break;
      row = node;
      node = composedParent(node);
    }
    return row;
  }

  function rowLabel(element: Element): string {
    if (
      !element.matches(
        "input,textarea,select,[role='combobox'],[role='textbox']",
      )
    )
      return "";
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return "";
    const row = rowContainer(element);
    return row
      ? (bestText({
          element,
          root: row,
          box,
          distanceFor: rowDistance,
          limit: 400,
          excludeLabels: false,
        })?.text ?? "")
      : "";
  }

  return { nearbyText, rowLabel };
}
