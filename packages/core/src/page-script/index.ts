import {
  CANDIDATE_LIMIT,
  DIGEST_LIMIT,
  isSafeRole,
  isWeakPeer,
  NAME_LIMIT,
  PAGE_PROTOCOL,
  PEER_LIMIT,
  type Aim,
  type AimResult,
  type Candidate,
  type CandidatePage,
  type DigestResult,
  type FillTarget,
  type Operation,
  type PageBridge,
  type PageVersion,
  type ReadTargetResult,
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
        candidates: readonly Candidate[];
        refs: Map<string, Element>;
        complete: boolean;
      }
    | undefined;
  const owned = new Map<
    Element,
    { old: string | null; ref: string; rawName: string }
  >();
  const nodeIds = new WeakMap<Element, string>();
  let nodeSequence = 0;
  const MAX_ELEMENTS = 20_000;
  const MAX_TEXT_NODES = 20_000;
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
  const modalOrder = new Map<HTMLDialogElement, number>();
  let modalSequence = 0;
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (
        change.type === "attributes" &&
        change.attributeName === "open" &&
        change.target instanceof HTMLDialogElement
      ) {
        if (change.oldValue === null && change.target.matches(":modal"))
          modalOrder.set(change.target, ++modalSequence);
        else if (!change.target.open) modalOrder.delete(change.target);
      }
    }
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
    attributeOldValue: true,
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
  function visible(element: Element, visualOnly = false): boolean {
    if (
      element.closest(
        visualOnly
          ? "[hidden],[inert],dialog:not([open])"
          : "[hidden],[inert],[aria-hidden='true'],dialog:not([open])",
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
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    if (element.getClientRects().length > 0) return true;
    if (style.display !== "contents") return false;
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).some(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  }
  /** Undefined means multiple modal scopes exist but their top layer is unknown. */
  function modal(): Element | null | undefined {
    for (const dialog of modalOrder.keys())
      if (!dialog.isConnected || !dialog.open) modalOrder.delete(dialog);
    const dialogs = Array.from(
      document.querySelectorAll(
        "dialog:modal,[role='dialog'][aria-modal='true']",
      ),
    ).filter((element) => visible(element));
    if (!dialogs.length) return null;
    const native = dialogs.filter((element): element is HTMLDialogElement =>
      element.matches("dialog:modal"),
    );
    if (native.length) {
      const ordered = [...native].sort(
        (a, b) => (modalOrder.get(b) ?? 0) - (modalOrder.get(a) ?? 0),
      );
      if ((modalOrder.get(ordered[0]!) ?? 0) > 0) return ordered[0]!;
      return (
        native.find((element) => element.contains(document.activeElement)) ??
        (native.length === 1 ? native[0] : undefined)
      );
    }
    // ARIA dialogs have no browser-maintained top-layer order. Focus is not
    // proof of visual stacking, so multiple scopes cannot be selected safely.
    return dialogs.length === 1 ? dialogs[0] : undefined;
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
        ["textbox", "searchbox", "combobox", "spinbutton"].includes(
          role(node),
        ) ||
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
  function referencedLabelText(element: Element): string {
    // ARIA names may explicitly reference visually hidden text inside the
    // control. That text is part of its accessible name even though it is not
    // ordinary page text for a digest or nearby context.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (
        parent?.closest(
          "script,style,noscript,input,textarea,select,[contenteditable]",
        )
      )
        continue;
      parts.push(walker.currentNode.textContent ?? "");
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  function label(element: Element): string {
    const aria = element.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const labelledby = element.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => {
          const named = document.getElementById(id);
          return named ? referencedLabelText(named) : "";
        })
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    if (element instanceof HTMLElement && "labels" in element) {
      const labels = (element as HTMLInputElement).labels;
      const text = labels?.length
        ? Array.from(labels).map(publicText).join(" ").trim()
        : "";
      if (text) return text;
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const placeholder = element.getAttribute("placeholder")?.trim();
      if (placeholder) return placeholder;
    }
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      const value = element.value.trim();
      if (value) return value;
    }
    return publicText(element) || element.getAttribute("title")?.trim() || "";
  }
  function boundedName(name: string): string {
    const points = Array.from(name);
    return points.length <= NAME_LIMIT
      ? name
      : points.slice(0, NAME_LIMIT - 1).join("") + "…";
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
          : element.type === "radio"
            ? "radio"
            : element.type === "range"
              ? "slider"
              : element.type === "number"
                ? "spinbutton"
                : element.type === "search"
                  ? "searchbox"
                  : "textbox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLSelectElement) return "combobox";
    return "";
  }
  function interactive(element: Element): boolean {
    if (element.parentElement?.closest("a[href]")) return false;
    return (
      element.matches(
        "button,a[href],input,textarea,select,[contenteditable]",
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
    if (element instanceof HTMLInputElement)
      return FILLABLE_INPUT_TYPES.has(element.type) && !disabled(element);
    if (element instanceof HTMLTextAreaElement) return !disabled(element);
    return (
      element instanceof HTMLElement &&
      element.isContentEditable &&
      !disabled(element)
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
  function inArticleBody(element: Element): boolean {
    return (
      !!element.closest("main,article,[role='main']") &&
      !element.closest("aside,nav,table,[role='navigation'],.infobox,.navbox")
    );
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
    // Some ranked tables place story metadata in the row immediately after
    // the ranked title row. Include the visible rank and title so "first
    // story comments" can be distinguished from the site navigation link.
    const row = element.closest("tr");
    const preceding = row?.previousElementSibling;
    const rank = preceding?.querySelector(".rank");
    const title = preceding?.querySelector(".titleline > a");
    const rankedPeer =
      rank && title
        ? Array.from(`${publicText(rank)} ${publicText(title)}`.trim())
            .slice(0, PEER_LIMIT)
            .join("")
        : "";
    let region: Element | null = element.parentElement;
    let lastUnique: Element | null = null;
    while (region && region !== document.body) {
      const possible = region.querySelectorAll(
        "button,a[href],[role='button'],input[type='button'],input[type='submit']",
      );
      // Large ancestors cannot supply a useful 80-character item context. In
      // particular, comparing every link in an article for every article link
      // turns a dense Wikipedia page into a quadratic scan.
      if (possible.length > 32) {
        region = lastUnique;
        break;
      }
      const sameLabel = Array.from(possible).filter(
        (item) => visible(item) && label(item) === name,
      );
      if (sameLabel.length > 1) {
        region = lastUnique;
        break;
      }
      lastUnique = region;
      if (region.matches("article,li,[data-product],[role='listitem']")) break;
      region = region.parentElement;
    }
    region = region === document.body ? lastUnique : region;
    if (!region)
      return { texts: rankedPeer ? [rankedPeer] : [], contextComplete: false };
    const result: string[] = [];
    if (rankedPeer) result.push(rankedPeer);
    const context = itemContext(region);
    if (context.text && result.length < 2) result.push(context.text);
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
      if (result.length === 2) break;
      if (
        child === element ||
        child.contains(element) ||
        element.contains(child) ||
        !visible(child)
      )
        continue;
      // Match the PoC's bounded-label behavior: a verbose product description
      // is useful context only up to the provider field limit. Truncating this
      // page-derived display text keeps a single long description from making
      // every otherwise-actionable candidate set unresolvable.
      const text = Array.from(publicText(child)).slice(0, PEER_LIMIT).join("");
      if (text && text !== name && !result.includes(text)) result.push(text);
    }
    return {
      texts: result,
      contextComplete: !rankedPeer && context.complete && !!context.text,
    };
  }
  function scan(operation: Operation): {
    candidates: readonly Candidate[];
    refs: Map<string, Element>;
    complete: boolean;
  } {
    clearRefs();
    const refs = new Map<string, Element>();
    const candidates: Candidate[] = [];
    const selectedModal = modal();
    if (selectedModal === undefined)
      return { candidates, refs, complete: false };
    const root = selectedModal ?? document.body;
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
      const rawName = label(element);
      if (!rawName) continue;
      const name = boundedName(rawName);
      const ref = `${documentId}-${++sequence}`;
      let nodeId = nodeIds.get(element);
      if (!nodeId) {
        nodeId = `${documentId}-node-${++nodeSequence}`;
        nodeIds.set(element, nodeId);
      }
      const peerData = peers(element, name);
      owned.set(element, {
        old: element.getAttribute("data-sedum-ref"),
        ref,
        rawName,
      });
      element.setAttribute("data-sedum-ref", ref);
      refs.set(ref, element);
      candidates.push(
        Object.freeze({
          ref,
          tag: element.tagName.toLowerCase(),
          role: role(element),
          name,
          peers: Object.freeze(peerData.texts),
          editable: editable(element),
          disabled: disabled(element),
          inputType: element instanceof HTMLInputElement ? element.type : "",
          signals: Object.freeze({
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
            ...(inArticleBody(element)
              ? { region: "article-body" as const }
              : {}),
            ...(rawName !== name ? { nameTruncated: true, rawName } : {}),
            nodeId,
            path: path(element),
            contextComplete: peerData.contextComplete,
          }),
        }),
      );
    }
    return { candidates: Object.freeze(candidates), refs, complete: true };
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
        !same(snapshot.version, input.version))
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
    const selectedModal = modal();
    if (selectedModal === undefined)
      return {
        protocol: PAGE_PROTOCOL,
        version: current,
        text: "",
        complete: false,
        error: "scope_ambiguous",
      };
    const root = selectedModal ?? document.body;
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
    // A non-editable combobox can render its selected value inside an
    // aria-hidden descendant. That text is visually present, but the ordinary
    // digest intentionally skips controls. Include only rendered selection
    // text; editable controls and their values remain excluded.
    for (const control of Array.from(
      root.querySelectorAll("[role='combobox'],select"),
    )) {
      if (
        !visible(control) ||
        control.matches("input,textarea,[contenteditable]")
      )
        continue;
      if (
        control.getAttribute("aria-autocomplete")?.toLowerCase() !== "none" &&
        !(control instanceof HTMLSelectElement)
      )
        continue;
      let selection = "";
      if (control instanceof HTMLSelectElement) {
        selection = control.selectedOptions[0]?.textContent?.trim() ?? "";
      } else {
        const stateWalker = document.createTreeWalker(
          control,
          NodeFilter.SHOW_TEXT,
        );
        const stateParts: string[] = [];
        while (stateWalker.nextNode()) {
          const parent = stateWalker.currentNode.parentElement;
          if (
            !parent ||
            !visible(parent, true) ||
            parent.closest(
              "input,textarea,select,[contenteditable],script,style,noscript,[role='textbox'],[role='searchbox'],[role='spinbutton']",
            )
          )
            continue;
          const part = (stateWalker.currentNode.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (part) stateParts.push(part);
        }
        selection = stateParts.join(" ");
      }
      if (!selection) continue;
      const part = `Selected combobox: ${selection}`;
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
  function fillElement(target: FillTarget): Element | null {
    const current = version();
    if (
      !snapshot ||
      snapshot.operation !== "fill" ||
      !same(snapshot.version, current) ||
      !same(target.version, current)
    )
      return null;
    const element = refElement(target.ref);
    if (!element || element.tagName.toLowerCase() !== target.tag) return null;
    const matches = Array.from(
      document.querySelectorAll("[data-sedum-ref]"),
    ).filter((node) => node.getAttribute("data-sedum-ref") === target.ref);
    if (matches.length !== 1 || matches[0] !== element) return null;
    const candidate = snapshot.candidates.find(
      (item) => item.ref === target.ref,
    );
    if (
      !candidate ||
      !candidate.editable ||
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLElement && element.isContentEditable)
      ) ||
      candidate.name !== target.name ||
      label(element) !== owned.get(element)?.rawName ||
      JSON.stringify(peers(element, candidate.name).texts) !==
        JSON.stringify(candidate.peers) ||
      !editable(element) ||
      !visible(element) ||
      disabled(element)
    )
      return null;
    return element;
  }
  function readTarget(target: FillTarget): ReadTargetResult {
    const current = version();
    if (
      !snapshot ||
      snapshot.operation !== "read" ||
      !same(snapshot.version, current) ||
      !same(target.version, current)
    )
      return { status: "stale" };
    const element = refElement(target.ref);
    const candidate = snapshot.candidates.find(
      (item) => item.ref === target.ref,
    );
    if (
      !element ||
      !candidate ||
      element.tagName.toLowerCase() !== target.tag ||
      candidate.name !== target.name ||
      !readable(element) ||
      !visible(element) ||
      label(element) !== owned.get(element)?.rawName ||
      JSON.stringify(peers(element, candidate.name).texts) !==
        JSON.stringify(candidate.peers)
    )
      return { status: "stale" };
    const text = publicText(element);
    if (!text) return { status: "empty" };
    if (Array.from(text).length > 4096) return { status: "too_long" };
    return { status: "ok", text };
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
      label(element) !== owned.get(element)?.rawName ||
      JSON.stringify(peers(element, candidate.name).texts) !==
        JSON.stringify(candidate.peers) ||
      (expected && expected.name !== candidate.name)
    )
      return { actionable: false, reason: "stale" };
    if (!visible(element) || disabled(element))
      return { actionable: false, reason: "not_actionable" };
    const enclosingLink = element.closest("a[href]");
    if (enclosingLink) {
      if (enclosingLink !== element)
        return { actionable: false, reason: "not_actionable" };
      if (
        enclosingLink instanceof HTMLAnchorElement &&
        (enclosingLink.hasAttribute("download") ||
          !["", "_self"].includes(enclosingLink.target) ||
          !["http:", "https:"].includes(new URL(enclosingLink.href).protocol))
      )
        return { actionable: false, reason: "not_actionable" };
    }
    const hitTest = (): AimResult | null => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
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
              box: {
                x: Math.max(0, rect.left / innerWidth),
                y: Math.max(0, rect.top / innerHeight),
                width: Math.min(1, rect.width / innerWidth),
                height: Math.min(1, rect.height / innerHeight),
              },
            },
          };
        }
      }
      return null;
    };
    // Scrolling a visible menu item can close or rerender its menu. Only move
    // the page when no point on the existing rect is currently hittable.
    const inPlace = hitTest();
    if (inPlace) return inPlace;
    if (expected) return { actionable: false, reason: "not_actionable" };
    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    if (!same(version(), current) || refElement(ref) !== element)
      return { actionable: false, reason: "stale" };
    return hitTest() ?? { actionable: false, reason: "not_actionable" };
  }
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
    readTarget,
    checkAim: (expected) => aim(expected.ref, expected),
    fillElement,
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
  Object.freeze(bridge);
  Object.defineProperty(window, "__sedum", {
    value: bridge,
    configurable: false,
    writable: false,
  });
}
