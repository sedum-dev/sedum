interface Dependencies {
  readonly document: Document;
  readonly observe: (root: Document | ShadowRoot) => void;
}

export function createDomTraversal(deps: Dependencies) {
  function composedParent(element: Element): Element | null {
    if (element.parentElement) return element.parentElement;
    return element.parentNode instanceof ShadowRoot
      ? element.parentNode.host
      : null;
  }

  function pushChildren(parent: ParentNode, stack: Element[]): void {
    for (let index = parent.children.length - 1; index >= 0; index--)
      stack.push(parent.children[index]!);
  }

  function pushDescendants(
    element: Element,
    stack: Element[],
    skipDrawings: boolean,
  ): void {
    if (skipDrawings && element instanceof SVGSVGElement) return;
    pushChildren(element, stack);
    if (!element.shadowRoot) return;
    deps.observe(element.shadowRoot);
    pushChildren(element.shadowRoot, stack);
  }

  function allElements(
    root: Element,
    limit: number,
    skipDrawings = false,
  ): Element[] | null {
    const result: Element[] = [];
    const stack: Element[] = [];
    if (root.shadowRoot) {
      deps.observe(root.shadowRoot);
      pushChildren(root.shadowRoot, stack);
    }
    pushChildren(root, stack);
    while (stack.length) {
      const element = stack.pop()!;
      result.push(element);
      if (result.length > limit) return null;
      pushDescendants(element, stack, skipDrawings);
    }
    return result;
  }

  function flatTextNodes(root: Node): Text[] {
    const result: Text[] = [];
    visitFlat(root, result);
    return result;
  }

  function visitFlat(node: Node, result: Text[]): void {
    if (node instanceof Text) {
      result.push(node);
      return;
    }
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      visitChildren(assigned.length ? assigned : node.childNodes, result);
      return;
    }
    const children =
      node instanceof Element && node.shadowRoot
        ? node.shadowRoot.childNodes
        : node.childNodes;
    visitChildren(children, result);
  }

  function visitChildren(
    children: NodeListOf<ChildNode> | readonly Node[],
    result: Text[],
  ): void {
    for (const child of Array.from(children)) visitFlat(child, result);
  }

  function deepElementFromPoint(x: number, y: number): Element | null {
    let hit = deps.document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const root = hit.shadowRoot;
      const inner = root
        .elementsFromPoint(x, y)
        .find((element) => element.getRootNode() === root);
      if (!inner) break;
      hit = inner;
    }
    return hit;
  }

  function deepContains(ancestor: Element, node: Element): boolean {
    for (
      let current: Element | null = node;
      current;
      current = composedParent(current)
    )
      if (current === ancestor) return true;
    return false;
  }

  return {
    composedParent,
    allElements,
    flatTextNodes,
    deepElementFromPoint,
    deepContains,
  };
}
