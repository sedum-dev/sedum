import {
  CANDIDATE_LIMIT,
  PAGE_PROTOCOL,
  type Candidate,
  type CandidatePage,
  type Operation,
  type PageVersion,
} from "../page-protocol.js";
import type { HeadingContext, PeerData } from "./candidate-context.js";

export interface CandidateSnapshot {
  readonly version: PageVersion;
  readonly operation: Operation;
  readonly candidates: readonly Candidate[];
  readonly refs: ReadonlyMap<string, Element>;
  readonly complete: boolean;
}

interface Dependencies {
  readonly document: Document;
  readonly documentId: string;
  readonly version: () => PageVersion;
  readonly sameVersion: (a: PageVersion, b: PageVersion) => boolean;
  readonly modal: () => Element | null | undefined;
  readonly allElements: (
    root: Element,
    limit: number,
    skipDrawings?: boolean,
  ) => Element[] | null;
  readonly resetContext: () => void;
  readonly resetHover: () => void;
  readonly observeHeading: (element: Element) => HeadingContext | null;
  readonly visible: (element: Element) => boolean;
  readonly transparentToggle: (element: Element) => boolean;
  readonly ariaHiddenOnly: (element: Element) => boolean;
  readonly hoverHost: (element: Element) => Element | null;
  readonly toggleLabel: (element: Element) => HTMLInputElement | null;
  readonly readable: (element: Element) => boolean;
  readonly interactive: (element: Element) => boolean;
  readonly pointerTarget: (element: Element) => boolean;
  readonly editable: (element: Element) => boolean;
  readonly role: (element: Element) => string;
  readonly label: (element: Element) => string;
  readonly candidateName: (element: Element, hoverRevealed?: boolean) => string;
  readonly boundedName: (name: string) => string;
  readonly peers: (
    element: Element,
    name: string,
    operation: Operation,
  ) => PeerData;
  readonly locationOf: (element: Element, heading: HeadingContext) => string;
  readonly sectionOf: (element: Element) => string;
  readonly nameHint: (element: Element, rawName: string) => string;
  readonly disabled: (element: Element) => boolean;
  readonly inArticleBody: (element: Element) => boolean;
  readonly path: (element: Element) => string;
}

interface CandidateParts {
  readonly element: Element;
  readonly operation: Operation;
  readonly proxied: HTMLInputElement | null;
  readonly heading: HeadingContext;
  readonly rawName: string;
}

interface SignalParts {
  readonly element: Element;
  readonly rawName: string;
  readonly name: string;
  readonly peerData: PeerData;
  readonly section: string;
  readonly hint: string;
}

const MAX_ELEMENTS = 20_000;

export function createCandidateScanner(deps: Dependencies) {
  let sequence = 0;
  let nodeSequence = 0;
  let snapshot: CandidateSnapshot | undefined;
  const owned = new Map<
    Element,
    { old: string | null; ref: string; rawName: string }
  >();
  const nodeIds = new WeakMap<Element, string>();

  function clearRefs(): void {
    for (const [element, entry] of owned) restoreRef(element, entry);
    owned.clear();
    snapshot = undefined;
  }

  function restoreRef(
    element: Element,
    entry: { old: string | null; ref: string },
  ): void {
    if (element.getAttribute("data-sedum-ref") !== entry.ref) return;
    if (entry.old === null) element.removeAttribute("data-sedum-ref");
    else element.setAttribute("data-sedum-ref", entry.old);
  }

  function scanElements(): { elements: Element[]; complete: boolean } {
    const selectedModal = deps.modal();
    if (selectedModal === undefined) return { elements: [], complete: false };
    const root = selectedModal ?? deps.document.body;
    if (!root) return { elements: [], complete: true };
    // Pages heavy with inline SVG art can pass the limit on drawing alone.
    const elements =
      deps.allElements(root, MAX_ELEMENTS) ??
      deps.allElements(root, MAX_ELEMENTS, true);
    return elements
      ? { elements, complete: true }
      : { elements: [], complete: false };
  }

  function eligible(
    element: Element,
    operation: Operation,
    proxied: HTMLInputElement | null,
    shownByHover: Element | null,
  ): boolean {
    if (!isShown(element, operation, shownByHover)) return false;
    if (operation === "read") return deps.readable(element);
    return isActionTarget(element, operation, proxied);
  }

  function isShown(
    element: Element,
    operation: Operation,
    shownByHover: Element | null,
  ): boolean {
    if (deps.visible(element) || deps.transparentToggle(element)) return true;
    if (operation !== "click") return false;
    return deps.ariaHiddenOnly(element) || !!shownByHover;
  }

  function isActionTarget(
    element: Element,
    operation: Operation,
    proxied: HTMLInputElement | null,
  ): boolean {
    if (deps.interactive(element) || proxied) return true;
    return operation === "click" && deps.pointerTarget(element);
  }

  function allowedForOperation(
    element: Element,
    operation: Operation,
  ): boolean {
    if (operation === "fill") return deps.editable(element);
    if (operation !== "click" || !deps.editable(element)) return true;
    if (element.matches("input[type='checkbox'],input[type='radio']"))
      return true;
    if (deps.role(element) === "combobox") return true;
    return !!(element as HTMLInputElement).readOnly;
  }

  function nodeId(element: Element): string {
    const existing = nodeIds.get(element);
    if (existing) return existing;
    const created = `${deps.documentId}-node-${++nodeSequence}`;
    nodeIds.set(element, created);
    return created;
  }

  function signals(parts: SignalParts): Candidate["signals"] {
    const { element, rawName, name, peerData, section, hint } = parts;
    const result: Record<string, unknown> = {};
    copyAttribute(result, "hook", element, "data-testid");
    if (element.id) result.id = element.id;
    copyAttribute(result, "name", element, "name");
    copyAttribute(result, "href", element, "href");
    if (deps.inArticleBody(element)) result.region = "article-body";
    if (rawName !== name)
      Object.assign(result, { nameTruncated: true, rawName });
    Object.assign(result, {
      nodeId: nodeId(element),
      path: deps.path(element),
      contextComplete: peerData.contextComplete,
    });
    if (peerData.item) result.item = peerData.item;
    if (section) result.section = section;
    if (hint) result.nameHint = hint;
    return Object.freeze(result) as Candidate["signals"];
  }

  function copyAttribute(
    target: Record<string, unknown>,
    key: string,
    element: Element,
    attribute: string,
  ): void {
    const value = element.getAttribute(attribute);
    if (value) target[key] = value;
  }

  function buildCandidate(parts: CandidateParts): Candidate {
    const { element, operation, proxied, heading, rawName } = parts;
    const name = deps.boundedName(rawName);
    const ref = `${deps.documentId}-${++sequence}`;
    const peerData = deps.peers(element, name, operation);
    const location = deps.locationOf(element, heading);
    const section = deps.sectionOf(element);
    const hint = operation === "read" ? "" : deps.nameHint(element, rawName);
    owned.set(element, {
      old: element.getAttribute("data-sedum-ref"),
      ref,
      rawName,
    });
    element.setAttribute("data-sedum-ref", ref);
    return Object.freeze({
      ref,
      tag: element.tagName.toLowerCase(),
      role: proxied ? deps.role(proxied) : deps.role(element),
      name,
      peers: Object.freeze(peerData.texts),
      ...(location ? { location } : {}),
      editable: deps.editable(element),
      disabled: deps.disabled(element),
      inputType: element instanceof HTMLInputElement ? element.type : "",
      signals: signals({ element, rawName, name, peerData, section, hint }),
    });
  }

  function candidateFor(
    element: Element,
    operation: Operation,
    heading: HeadingContext,
  ): Candidate | null {
    const proxied = operation === "click" ? deps.toggleLabel(element) : null;
    const shownByHover =
      operation === "click" && !deps.visible(element)
        ? deps.hoverHost(element)
        : null;
    if (!eligible(element, operation, proxied, shownByHover)) return null;
    if (!allowedForOperation(element, operation)) return null;
    const rawName =
      operation === "read"
        ? deps.label(element)
        : deps.candidateName(element, !!shownByHover);
    return rawName
      ? buildCandidate({ element, operation, proxied, heading, rawName })
      : null;
  }

  function scan(
    operation: Operation,
  ): Omit<CandidateSnapshot, "version" | "operation"> {
    clearRefs();
    const refs = new Map<string, Element>();
    const candidates: Candidate[] = [];
    const found = scanElements();
    if (!found.complete) return { candidates, refs, complete: false };
    let heading: HeadingContext = { text: "", root: null };
    deps.resetContext();
    deps.resetHover();
    for (const element of found.elements) {
      heading = deps.observeHeading(element) ?? heading;
      const candidate = candidateFor(element, operation, heading);
      if (!candidate) continue;
      refs.set(candidate.ref, element);
      candidates.push(candidate);
    }
    return { candidates: Object.freeze(candidates), refs, complete: true };
  }

  function emptyPage(current: PageVersion, offset: number): CandidatePage {
    return {
      protocol: PAGE_PROTOCOL,
      version: current,
      total: 0,
      offset,
      next: null,
      complete: false,
      candidates: [],
    };
  }

  function validContinuation(
    operation: Operation,
    requestedVersion: PageVersion | undefined,
  ): boolean {
    return !!(
      snapshot &&
      snapshot.operation === operation &&
      requestedVersion &&
      deps.sameVersion(snapshot.version, requestedVersion)
    );
  }

  function page(offset: number): CandidatePage {
    const current = snapshot!;
    if (!current.complete) return emptyPage(current.version, offset);
    const candidates = current.candidates.slice(
      offset,
      offset + CANDIDATE_LIMIT,
    );
    const consumed = offset + candidates.length;
    return {
      protocol: PAGE_PROTOCOL,
      version: current.version,
      total: current.candidates.length,
      offset,
      next: consumed < current.candidates.length ? consumed : null,
      complete: true,
      candidates,
    };
  }

  function collect(input: {
    operation: Operation;
    offset?: number;
    version?: PageVersion;
  }): CandidatePage {
    const current = deps.version();
    const offset = input.offset ?? 0;
    if (offset > 0 && !validContinuation(input.operation, input.version))
      return emptyPage(current, offset);
    if (offset === 0) {
      const result = scan(input.operation);
      snapshot = {
        version: deps.version(),
        operation: input.operation,
        ...result,
      };
    }
    return page(offset);
  }

  return {
    collect,
    clearRefs,
    snapshot: () => snapshot,
    rawName: (element: Element) => owned.get(element)?.rawName,
    candidates: () => snapshot?.candidates ?? [],
  };
}
