import type {
  Aim,
  AimResult,
  Candidate,
  ControlStateResult,
  FillTarget,
  Operation,
  PageVersion,
  ReadTargetResult,
} from "../page-protocol.js";

export interface TargetSnapshot {
  readonly version: PageVersion;
  readonly operation: Operation;
  readonly candidates: readonly Candidate[];
  readonly refs: ReadonlyMap<string, Element>;
}

interface PeerData {
  readonly texts: readonly string[];
}

interface TargetActionDependencies {
  readonly document: Document;
  readonly snapshot: () => TargetSnapshot | undefined;
  readonly version: () => PageVersion;
  readonly sameVersion: (a: PageVersion, b: PageVersion) => boolean;
  readonly rawName: (element: Element) => string | undefined;
  readonly allElements: (root: Element, limit: number) => Element[] | null;
  readonly candidateName: (element: Element, hoverRevealed?: boolean) => string;
  readonly peers: (
    element: Element,
    name: string,
    operation?: Operation,
  ) => PeerData;
  readonly editable: (element: Element) => boolean;
  readonly readable: (element: Element) => boolean;
  readonly visible: (element: Element) => boolean;
  readonly disabled: (element: Element) => boolean;
  readonly label: (element: Element) => string;
  readonly publicText: (element: Element) => string;
  readonly toggleLabel: (element: Element) => HTMLInputElement | null;
  readonly isToggle: (element: Element) => element is HTMLInputElement;
  readonly deepContains: (ancestor: Element, node: Element) => boolean;
  readonly hoverHost: (element: Element) => Element | null;
  readonly transparentToggle: (element: Element) => boolean;
  readonly ariaHiddenOnly: (element: Element) => boolean;
  readonly deepElementFromPoint: (x: number, y: number) => Element | null;
  readonly viewport: () => { readonly width: number; readonly height: number };
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

export function createTargetActions(deps: TargetActionDependencies) {
  function refElement(ref: string): Element | null {
    const element = deps.snapshot()?.refs.get(ref);
    if (!element) return null;
    if (!element.isConnected) return null;
    if (element.ownerDocument !== deps.document) return null;
    return element.getAttribute("data-sedum-ref") === ref ? element : null;
  }

  function snapshotFor(target: FillTarget, operations: readonly Operation[]) {
    const current = deps.version();
    const snapshot = deps.snapshot();
    if (!snapshot || !operations.includes(snapshot.operation)) return null;
    if (!deps.sameVersion(snapshot.version, current)) return null;
    return deps.sameVersion(target.version, current) ? snapshot : null;
  }

  function candidateFor(snapshot: TargetSnapshot, target: FillTarget) {
    const element = refElement(target.ref);
    const candidate = snapshot.candidates.find(
      (item) => item.ref === target.ref,
    );
    if (!element || !candidate) return null;
    if (element.tagName.toLowerCase() !== target.tag) return null;
    return candidate.name === target.name ? { element, candidate } : null;
  }

  function samePeers(
    element: Element,
    candidate: Candidate,
    operation?: Operation,
  ) {
    return (
      JSON.stringify(deps.peers(element, candidate.name, operation).texts) ===
      JSON.stringify(candidate.peers)
    );
  }

  function uniqueRef(element: Element, ref: string): boolean {
    const matches = (
      deps.allElements(deps.document.documentElement, Infinity) ?? []
    ).filter((node) => node.getAttribute("data-sedum-ref") === ref);
    return matches.length === 1 && matches[0] === element;
  }

  function isFillControl(element: Element): boolean {
    return [
      element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement,
      element instanceof HTMLElement && element.isContentEditable,
    ].includes(true);
  }

  function fillElement(target: FillTarget): Element | null {
    const snapshot = snapshotFor(target, ["fill"]);
    if (!snapshot) return null;
    const found = candidateFor(snapshot, target);
    if (!found || !uniqueRef(found.element, target.ref)) return null;
    const { element, candidate } = found;
    return validFillTarget(element, candidate) ? element : null;
  }

  function validFillTarget(element: Element, candidate: Candidate): boolean {
    if (!validFillIdentity(element, candidate)) return false;
    return actionableFill(element);
  }

  function validFillIdentity(element: Element, candidate: Candidate): boolean {
    return [
      candidate.editable,
      isFillControl(element),
      deps.candidateName(element) === deps.rawName(element),
      samePeers(element, candidate),
    ].every(Boolean);
  }

  function actionableFill(element: Element): boolean {
    return [
      deps.editable(element),
      deps.visible(element),
      !deps.disabled(element),
    ].every(Boolean);
  }

  function readTarget(target: FillTarget): ReadTargetResult {
    const snapshot = snapshotFor(target, ["read"]);
    if (!snapshot) return { status: "stale" };
    const found = candidateFor(snapshot, target);
    if (!found || !validReadTarget(found.element, found.candidate))
      return { status: "stale" };
    const text = deps.publicText(found.element);
    if (!text) return { status: "empty" };
    return Array.from(text).length > 4096
      ? { status: "too_long" }
      : { status: "ok", text };
  }

  function validReadTarget(element: Element, candidate: Candidate): boolean {
    if (!readIdentityMatches(element, candidate)) return false;
    return deps.readable(element) && deps.visible(element);
  }

  function readIdentityMatches(
    element: Element,
    candidate: Candidate,
  ): boolean {
    if (deps.label(element) !== deps.rawName(element)) return false;
    return samePeers(element, candidate, "read");
  }

  function activeElement(root: Document | ShadowRoot): Element | null {
    const focused = root.activeElement;
    return focused?.shadowRoot
      ? (activeElement(focused.shadowRoot) ?? focused)
      : focused;
  }

  function textValue(element: Element): string | null {
    if (publicTextField(element))
      return (element as HTMLInputElement | HTMLTextAreaElement).value;
    if (!(element instanceof HTMLElement)) return null;
    return element.isContentEditable ? (element.textContent ?? "") : null;
  }

  function publicTextField(element: Element): boolean {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    if (!FILLABLE_INPUT_TYPES.has(element.type)) return false;
    return element.type !== "password";
  }

  function checkedState(control: Element): boolean | null {
    if (deps.isToggle(control)) return control.checked;
    const checked = control.getAttribute("aria-checked");
    if (checked === "true" || checked === "mixed") return true;
    return checked === "false" ? false : null;
  }

  function controlState(target: FillTarget): ControlStateResult {
    const snapshot = snapshotFor(target, ["click", "fill"]);
    if (!snapshot) return { status: "stale" };
    const found = candidateFor(snapshot, target);
    if (!found) return { status: "stale" };
    const control = deps.toggleLabel(found.element) ?? found.element;
    const focused = activeElement(deps.document);
    return {
      status: "ok",
      disabled: deps.disabled(control),
      checked: checkedState(control),
      focused:
        !!focused &&
        (focused === control || deps.deepContains(control, focused)),
      value: textValue(found.element),
    };
  }

  function currentAim(ref: string, expected?: Aim) {
    const current = deps.version();
    const snapshot = deps.snapshot();
    if (!snapshot || !deps.sameVersion(snapshot.version, current)) return null;
    if (expected && !matchesVersion(expected, current)) return null;
    return { current, snapshot, element: refElement(ref) };
  }

  function matchesVersion(expected: Aim, current: PageVersion): boolean {
    return (
      expected.document === current.document &&
      expected.route === current.route &&
      expected.revision === current.revision
    );
  }

  function validAimIdentity(
    element: Element,
    candidate: Candidate,
    expected?: Aim,
  ): boolean {
    if (expected && element.tagName.toLowerCase() !== expected.tag)
      return false;
    if (
      deps.candidateName(element, !!deps.hoverHost(element)) !==
      deps.rawName(element)
    )
      return false;
    if (!samePeers(element, candidate)) return false;
    return !expected || expected.name === candidate.name;
  }

  function isSafeAction(element: Element, shownBy: Element | null): boolean {
    if (!isShownAction(element, shownBy)) return false;
    if (deps.disabled(element)) return false;
    const link = element.closest("a[href]");
    if (!link) return true;
    if (link !== element) return false;
    if (!(link instanceof HTMLAnchorElement)) return true;
    return isSafeLink(link);
  }

  function isShownAction(element: Element, shownBy: Element | null): boolean {
    return [
      deps.visible(element),
      deps.transparentToggle(element),
      deps.ariaHiddenOnly(element),
      !!shownBy,
    ].includes(true);
  }

  function isSafeLink(link: HTMLAnchorElement): boolean {
    if (link.hasAttribute("download")) return false;
    if (!["", "_self"].includes(link.target)) return false;
    return ["http:", "https:"].includes(new URL(link.href).protocol);
  }

  function points(rect: DOMRect, expected: Aim | undefined, direct: boolean) {
    if (useExpectedPoint(expected, direct))
      return [[expected.point.x / rect.width, expected.point.y / rect.height]];
    return [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
    ];
  }

  function useExpectedPoint(
    expected: Aim | undefined,
    direct: boolean,
  ): expected is Aim {
    if (!expected || !direct) return false;
    return !expected.hover;
  }

  interface HitInput {
    readonly ref: string;
    readonly current: PageVersion;
    readonly element: Element;
    readonly candidate: Candidate;
    readonly shownBy: Element | null;
    readonly expected: Aim | undefined;
  }

  interface HitPointInput {
    readonly input: HitInput;
    readonly target: Element;
    readonly rect: DOMRect;
    readonly fx: number;
    readonly fy: number;
  }

  function hitTest(input: HitInput): AimResult | null {
    const target =
      input.shownBy && !deps.visible(input.element)
        ? input.shownBy
        : input.element;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    for (const [fx, fy] of points(
      rect,
      input.expected,
      target === input.element,
    )) {
      const result = hitPoint({ input, target, rect, fx: fx!, fy: fy! });
      if (result) return result;
    }
    return null;
  }

  function hitPoint(point: HitPointInput): AimResult | null {
    const { input, target, rect, fx, fy } = point;
    const { width, height } = deps.viewport();
    const x = rect.left + rect.width * fx;
    const y = rect.top + rect.height * fy;
    if (outsideViewport(x, y, width, height)) return null;
    const hit = deps.deepElementFromPoint(x, y);
    if (!hit || !deps.deepContains(target, hit)) return null;
    return {
      actionable: true,
      aim: {
        ref: input.ref,
        ...input.current,
        tag: input.element.tagName.toLowerCase(),
        name: input.candidate.name,
        point:
          target === input.element
            ? { x: rect.width * fx, y: rect.height * fy }
            : { x: 0, y: 0 },
        ...(input.shownBy ? { hover: true } : {}),
        box: {
          x: Math.max(0, rect.left / width),
          y: Math.max(0, rect.top / height),
          width: Math.min(1, rect.width / width),
          height: Math.min(1, rect.height / height),
        },
      },
    };
  }

  function outsideViewport(
    x: number,
    y: number,
    width: number,
    height: number,
  ): boolean {
    if (x < 0 || y < 0) return true;
    return x >= width || y >= height;
  }

  function aim(ref: string, expected?: Aim): AimResult {
    const state = currentAim(ref, expected);
    if (!state) return { actionable: false, reason: "stale" };
    if (!state.element) return { actionable: false, reason: "target_missing" };
    const candidate = aimCandidate(
      state.snapshot,
      state.element,
      ref,
      expected,
    );
    if (!candidate) return { actionable: false, reason: "stale" };
    const shownBy = deps.visible(state.element)
      ? null
      : deps.hoverHost(state.element);
    if (!isSafeAction(state.element, shownBy))
      return { actionable: false, reason: "not_actionable" };
    const input = {
      ref,
      current: state.current,
      element: state.element,
      candidate,
      shownBy,
      expected,
    };
    const inPlace = hitTest(input);
    if (inPlace) return inPlace;
    if (expected) return { actionable: false, reason: "not_actionable" };
    return retryAfterScroll(input);
  }

  function aimCandidate(
    snapshot: TargetSnapshot,
    element: Element,
    ref: string,
    expected: Aim | undefined,
  ): Candidate | null {
    const candidate = snapshot.candidates.find((item) => item.ref === ref);
    if (!candidate) return null;
    return validAimIdentity(element, candidate, expected) ? candidate : null;
  }

  function retryAfterScroll(input: HitInput): AimResult {
    input.element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    if (targetChanged(input.ref, input.current, input.element))
      return { actionable: false, reason: "stale" };
    return hitTest(input) ?? { actionable: false, reason: "not_actionable" };
  }

  function targetChanged(
    ref: string,
    version: PageVersion,
    element: Element,
  ): boolean {
    if (!deps.sameVersion(deps.version(), version)) return true;
    return refElement(ref) !== element;
  }

  function hoverElement(expected: Aim): Element | null {
    const current = deps.version();
    const snapshot = deps.snapshot();
    if (!snapshot || !deps.sameVersion(snapshot.version, current)) return null;
    const element = refElement(expected.ref);
    if (!element || element.tagName.toLowerCase() !== expected.tag) return null;
    if (deps.candidateName(element, true) !== deps.rawName(element))
      return null;
    return deps.visible(element) ? null : deps.hoverHost(element);
  }

  return {
    refElement,
    fillElement,
    readTarget,
    controlState,
    aim,
    hoverElement,
  };
}
