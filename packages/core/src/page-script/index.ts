import {
  CANDIDATE_LIMIT,
  DIGEST_LIMIT,
  isSafeRole,
  isWeakPeer,
  PAGE_PROTOCOL,
  PEER_LIMIT,
  type Aim,
  type AimResult,
  type Candidate,
  type CandidatePage,
  type DigestResult,
  type Operation,
  type PageBridge,
  type PageVersion,
} from "../page-protocol.js";

if (!window.__sedum) {
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)))
    .map((part) => part.toString(16))
    .join("-");
  let revision = 0;
  let route = location.href;
  let sequence = 0;
  let snapshot:
    | {
        version: PageVersion;
        operation: Operation;
        candidates: Candidate[];
        refs: Map<string, Element>;
        complete: boolean;
      }
    | undefined;
  const owned = new Map<Element, { old: string | null; ref: string }>();
  const MAX_ELEMENTS = 20_000;
  const MAX_TEXT_NODES = 20_000;
  const EDITABLE_ROLES = new Set([
    "textbox",
    "searchbox",
    "combobox",
    "spinbutton",
    "slider",
  ]);
  const observer = new MutationObserver((changes) => {
    if (
      changes.some(
        (change) =>
          change.type !== "attributes" ||
          change.attributeName !== "data-sedum-ref",
      )
    )
      revision++;
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  function version(): PageVersion {
    if (route !== location.href) {
      route = location.href;
      revision++;
    }
    return { document: documentId, revision, route };
  }
  function same(a: PageVersion, b: PageVersion): boolean {
    return (
      a.document === b.document &&
      a.revision === b.revision &&
      a.route === b.route
    );
  }
  function clearRefs(): void {
    for (const [element, { old, ref }] of owned) {
      if (element.getAttribute("data-sedum-ref") !== ref) continue;
      if (old === null) element.removeAttribute("data-sedum-ref");
      else element.setAttribute("data-sedum-ref", old);
    }
    owned.clear();
    snapshot = undefined;
  }
  function visible(element: Element): boolean {
    if (
      element.closest(
        "[hidden],[inert],[aria-hidden='true'],dialog:not([open])",
      )
    )
      return false;
    const dialog = element.closest("dialog,[role='dialog']");
    if (dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        bounds.right <= 0 ||
        bounds.bottom <= 0 ||
        bounds.left >= innerWidth ||
        bounds.top >= innerHeight
      )
        return false;
    }
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        Number.parseFloat(style.opacity) === 0 ||
        style.contentVisibility === "hidden"
      )
        return false;
    }
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      element.getClientRects().length > 0
    );
  }
  function modal(): Element | null {
    const dialogs = Array.from(
      document.querySelectorAll(
        "dialog:modal,[role='dialog'][aria-modal='true']",
      ),
    ).filter(visible);
    return (
      [...dialogs]
        .reverse()
        .find((element) => element.contains(document.activeElement)) ??
      dialogs.at(-1) ??
      null
    );
  }
  function excludedTextAncestor(
    element: Element,
    includeActions = false,
  ): boolean {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (
        node.matches(
          "input,textarea,select,[contenteditable],script,style,noscript",
        ) ||
        EDITABLE_ROLES.has(role(node)) ||
        (includeActions &&
          (node.matches("button,a[href]") ||
            role(node) === "button" ||
            role(node) === "link"))
      )
        return true;
    }
    return false;
  }
  function publicText(element: Element): string {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && visible(parent) && !excludedTextAncestor(parent))
        parts.push(walker.currentNode.textContent ?? "");
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  function label(element: Element): string {
    const aria = element.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = element.getAttribute("aria-labelledby");
    if (labelledby)
      return labelledby
        .split(/\s+/)
        .map((id) => {
          const named = document.getElementById(id);
          return named ? publicText(named) : "";
        })
        .filter(Boolean)
        .join(" ");
    if (element instanceof HTMLElement && "labels" in element) {
      const labels = (element as HTMLInputElement).labels;
      if (labels?.length) return Array.from(labels).map(publicText).join(" ");
    }
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    )
      return element.value.trim();
    return publicText(element);
  }
  function role(element: Element): string {
    const explicit = element.getAttribute("role");
    const canonical = explicit?.split(/\s+/).find(isSafeRole);
    if (canonical) return canonical;
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLInputElement)
      return ["button", "submit", "reset"].includes(element.type)
        ? "button"
        : element.type === "checkbox"
          ? "checkbox"
          : "textbox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLSelectElement) return "combobox";
    return "";
  }
  function interactive(element: Element): boolean {
    return (
      element.matches(
        "button,a[href],input,textarea,select,[contenteditable='true']",
      ) ||
      [
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
      ].includes(role(element))
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
  function editable(element: Element): boolean {
    return (
      element.matches(
        "input:not([type='button']):not([type='submit']):not([type='reset']),textarea,select,[contenteditable='true']",
      ) || EDITABLE_ROLES.has(role(element))
    );
  }
  function disabled(element: Element): boolean {
    return (
      element.matches(":disabled,[aria-disabled='true']") ||
      !!element.closest("[inert]")
    );
  }
  function path(element: Element): string {
    const steps: string[] = [];
    for (
      let node: Element | null = element;
      node && steps.length < 12;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter(
            (child) => child.tagName === node?.tagName,
          )
        : [node];
      steps.unshift(`${node.tagName.toLowerCase()}:${siblings.indexOf(node)}`);
    }
    return steps.join("/");
  }
  function itemContext(region: Element): { text: string; complete: boolean } {
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    let length = 0;
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || !visible(parent) || excludedTextAncestor(parent, true))
        continue;
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
  function peers(
    element: Element,
    name: string,
  ): { texts: string[]; contextComplete: boolean } {
    let region: Element | null = element.parentElement;
    let lastUnique: Element | null = null;
    while (region && region !== document.body) {
      const sameLabel = Array.from(
        region.querySelectorAll(
          "button,a[href],[role='button'],input[type='button'],input[type='submit']",
        ),
      ).filter((item) => visible(item) && label(item) === name);
      if (sameLabel.length > 1) {
        region = lastUnique;
        break;
      }
      lastUnique = region;
      if (region.matches("article,li,[data-product],[role='listitem']")) break;
      region = region.parentElement;
    }
    region = region === document.body ? lastUnique : region;
    if (!region) return { texts: [], contextComplete: false };
    const result: string[] = [];
    const context = itemContext(region);
    if (context.text) result.push(context.text);
    const named = Array.from(
      region.querySelectorAll(
        "[data-product-name],h1,h2,h3,h4,h5,h6,[role='heading']",
      ),
    );
    const meaningfulLeaves = Array.from(
      region.querySelectorAll("div,span,strong,p"),
    )
      .filter(
        (child) =>
          child.children.length === 0 && !isWeakPeer(publicText(child)),
      )
      .sort(
        (a, b) => Number(b.tagName === "DIV") - Number(a.tagName === "DIV"),
      );
    const nearby = Array.from(region.querySelectorAll("strong,span,p"));
    for (const child of [...named, ...meaningfulLeaves, ...nearby]) {
      if (
        child === element ||
        child.contains(element) ||
        element.contains(child) ||
        !visible(child)
      )
        continue;
      const text = publicText(child);
      if (text && text !== name && !result.includes(text)) result.push(text);
      if (result.length === 2) break;
    }
    return {
      texts: result,
      contextComplete: context.complete && !!context.text,
    };
  }
  function scan(operation: Operation): {
    candidates: Candidate[];
    refs: Map<string, Element>;
    complete: boolean;
  } {
    clearRefs();
    const refs = new Map<string, Element>();
    const candidates: Candidate[] = [];
    const root = modal() ?? document.body;
    if (!root) return { candidates, refs, complete: true };
    const elements = root.querySelectorAll("*");
    if (elements.length > MAX_ELEMENTS)
      return { candidates, refs, complete: false };
    for (const element of Array.from(elements)) {
      if (
        !visible(element) ||
        (operation === "read" ? !readable(element) : !interactive(element))
      )
        continue;
      if (operation === "fill" && !editable(element)) continue;
      if (
        operation === "click" &&
        editable(element) &&
        !element.matches("input[type='checkbox'],input[type='radio']")
      )
        continue;
      const name = label(element);
      if (!name) continue;
      const ref = `${documentId}-${++sequence}`;
      const peerData = peers(element, name);
      owned.set(element, { old: element.getAttribute("data-sedum-ref"), ref });
      element.setAttribute("data-sedum-ref", ref);
      refs.set(ref, element);
      candidates.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role: role(element),
        name,
        peers: peerData.texts,
        editable: editable(element),
        disabled: disabled(element),
        inputType: element instanceof HTMLInputElement ? element.type : "",
        signals: {
          ...(element.getAttribute("data-testid")
            ? { hook: element.getAttribute("data-testid")! }
            : {}),
          ...(element.id ? { id: element.id } : {}),
          ...(element.getAttribute("name")
            ? { name: element.getAttribute("name")! }
            : {}),
          ...(element.getAttribute("href")
            ? { href: element.getAttribute("href")! }
            : {}),
          path: path(element),
          contextComplete: peerData.contextComplete,
        },
      });
    }
    return { candidates, refs, complete: true };
  }
  function collect(input: {
    operation: Operation;
    offset?: number;
    version?: PageVersion;
  }): CandidatePage {
    const current = version();
    const offset = input.offset ?? 0;
    if (
      offset > 0 &&
      (!snapshot ||
        snapshot.operation !== input.operation ||
        !input.version ||
        !same(snapshot.version, input.version) ||
        !same(current, input.version))
    )
      return {
        protocol: PAGE_PROTOCOL,
        version: current,
        total: 0,
        offset,
        next: null,
        complete: false,
        candidates: [],
      };
    if (offset === 0) {
      const result = scan(input.operation);
      snapshot = { version: version(), operation: input.operation, ...result };
    }
    const currentSnapshot = snapshot!;
    if (!currentSnapshot.complete)
      return {
        protocol: PAGE_PROTOCOL,
        version: currentSnapshot.version,
        total: 0,
        offset,
        next: null,
        complete: false,
        candidates: [],
      };
    const candidates = currentSnapshot.candidates.slice(
      offset,
      offset + CANDIDATE_LIMIT,
    );
    const next =
      offset + candidates.length < currentSnapshot.candidates.length
        ? offset + candidates.length
        : null;
    return {
      protocol: PAGE_PROTOCOL,
      version: currentSnapshot.version,
      total: currentSnapshot.candidates.length,
      offset,
      next,
      complete: true,
      candidates,
    };
  }
  function digest(): DigestResult {
    const current = version();
    const root = modal() ?? document.body;
    if (!root)
      return {
        protocol: PAGE_PROTOCOL,
        version: current,
        text: "",
        complete: true,
      };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    let size = 0;
    let count = 0;
    while (walker.nextNode()) {
      if (++count > MAX_TEXT_NODES)
        return {
          protocol: PAGE_PROTOCOL,
          version: current,
          text: "",
          complete: false,
          error: "resource_ceiling",
        };
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || !visible(parent) || excludedTextAncestor(parent)) continue;
      const part = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!part) continue;
      size += Array.from(part).length + (pieces.length ? 1 : 0);
      if (size > DIGEST_LIMIT)
        return {
          protocol: PAGE_PROTOCOL,
          version: current,
          text: "",
          complete: false,
          error: "digest_too_large",
        };
      pieces.push(part);
    }
    return {
      protocol: PAGE_PROTOCOL,
      version: current,
      text: pieces.join(" "),
      complete: true,
    };
  }
  function refElement(ref: string): Element | null {
    const element = snapshot?.refs.get(ref);
    if (
      !element ||
      !element.isConnected ||
      element.ownerDocument !== document ||
      element.getAttribute("data-sedum-ref") !== ref
    )
      return null;
    return element;
  }
  function aim(ref: string, expected?: Aim): AimResult {
    const current = version();
    if (!snapshot || !same(snapshot.version, current))
      return { actionable: false, reason: "stale" };
    if (
      expected &&
      (expected.document !== current.document ||
        expected.route !== current.route ||
        expected.revision !== current.revision)
    )
      return { actionable: false, reason: "stale" };
    const element = refElement(ref);
    if (!element) return { actionable: false, reason: "target_missing" };
    if (expected && element.tagName.toLowerCase() !== expected.tag)
      return { actionable: false, reason: "stale" };
    const candidate = snapshot?.candidates.find((item) => item.ref === ref);
    if (
      !candidate ||
      label(element) !== candidate.name ||
      JSON.stringify(peers(element, candidate.name).texts) !==
        JSON.stringify(candidate.peers) ||
      (expected && expected.name !== candidate.name)
    )
      return { actionable: false, reason: "stale" };
    if (!visible(element) || disabled(element))
      return { actionable: false, reason: "not_actionable" };
    if (
      element instanceof HTMLAnchorElement &&
      (element.hasAttribute("download") ||
        !["", "_self"].includes(element.target) ||
        !["http:", "https:"].includes(new URL(element.href).protocol))
    )
      return { actionable: false, reason: "not_actionable" };
    if (!expected)
      element.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height)
      return { actionable: false, reason: "not_actionable" };
    const points = expected
      ? [[expected.point.x / rect.width, expected.point.y / rect.height]]
      : [
          [0.5, 0.5],
          [0.25, 0.5],
          [0.75, 0.5],
          [0.5, 0.25],
          [0.5, 0.75],
        ];
    for (const [fx, fy] of points) {
      const x = rect.left + rect.width * fx!;
      const y = rect.top + rect.height * fy!;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === element || element.contains(hit))) {
        return {
          actionable: true,
          aim: {
            ref,
            document: current.document,
            route: current.route,
            revision: current.revision,
            tag: element.tagName.toLowerCase(),
            name: candidate.name,
            point: { x: rect.width * fx!, y: rect.height * fy! },
          },
        };
      }
    }
    return { actionable: false, reason: "not_actionable" };
  }
  let activeClick:
    | {
        expected: Aim;
        element: Element;
        anchor: HTMLAnchorElement | null;
        href: string | null;
        held: boolean;
        blocked: boolean;
        pageCanceled: boolean;
        cancellationUnknown: boolean;
      }
    | undefined;
  // Registered by the init script before page code can register capture handlers.
  // Link defaults are held because later handlers can mutate href and stop propagation.
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"])
    window.addEventListener(
      type,
      (event) => {
        const active = activeClick;
        if (!active) return;
        const receiver = event.target;
        if (
          !(receiver instanceof Node) ||
          (receiver !== active.element && !active.element.contains(receiver)) ||
          !aim(active.expected.ref, active.expected).actionable
        ) {
          active.blocked = true;
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (type === "click" && active.anchor) {
          active.held = true;
          const cancel = event.preventDefault.bind(event);
          cancel();
          try {
            Object.defineProperty(event, "preventDefault", {
              configurable: true,
              value: () => {
                active.pageCanceled = true;
                cancel();
              },
            });
            Object.defineProperty(event, "returnValue", {
              configurable: true,
              get: () => false,
              set: (value: boolean) => {
                if (value === false) active.pageCanceled = true;
                cancel();
              },
            });
          } catch {
            active.cancellationUnknown = true;
          }
        }
      },
      true,
    );
  const bridge: PageBridge = {
    protocol: PAGE_PROTOCOL,
    collect,
    digest,
    pageVersion: version,
    findBySignals: ({ operation }) => {
      const first = collect({ operation });
      return { ...first, candidates: snapshot?.candidates ?? [], next: null };
    },
    clickTarget: (ref) => aim(ref),
    checkAim: (expected) => aim(expected.ref, expected),
    armClick: (expected) => {
      if (activeClick || !aim(expected.ref, expected).actionable) return false;
      const element = refElement(expected.ref);
      if (!element) return false;
      const anchor = element.closest("a[href]");
      activeClick = {
        expected,
        element,
        anchor: anchor instanceof HTMLAnchorElement ? anchor : null,
        href: anchor instanceof HTMLAnchorElement ? anchor.href : null,
        held: false,
        blocked: false,
        pageCanceled: false,
        cancellationUnknown:
          anchor instanceof HTMLAnchorElement &&
          (anchor.onclick !== null ||
            anchor.querySelector("[onclick]") !== null),
      };
      return true;
    },
    finishClick: () => {
      const active = activeClick;
      activeClick = undefined;
      if (!active)
        return {
          blocked: true,
          heldHref: null,
          pageCanceled: false,
          cancellationUnknown: true,
        };
      return {
        blocked:
          active.blocked ||
          (active.anchor !== null && active.anchor.href !== active.href),
        heldHref: active.held ? active.href : null,
        pageCanceled: active.pageCanceled,
        cancellationUnknown: active.cancellationUnknown,
      };
    },
    clearRefs,
    quiet: async ({ ms, timeoutMs }) => {
      const started = performance.now();
      let stable = performance.now();
      let last = version();
      while (performance.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, ms)));
        const now = version();
        if (!same(last, now)) {
          last = now;
          stable = performance.now();
        }
        if (performance.now() - stable >= ms)
          return { version: now, quiet: true };
      }
      return { version: version(), quiet: false };
    },
  };
  window.__sedum = bridge;
}
