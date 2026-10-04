import { createCandidateContext } from "./candidate-context.js";
import { createCandidateNames } from "./candidate-names.js";
import { createCandidateScanner } from "./candidate-scanner.js";
import { createDomTraversal } from "./dom-traversal.js";
import { createElementSemantics } from "./element-semantics.js";
import { createHoverDiscovery } from "./hover.js";
import { createPageLifecycle } from "./page-lifecycle.js";
import { createPageText } from "./page-text.js";
import { createTargetActions } from "./target-actions.js";
import { createVisualCandidates } from "./visual-candidates.js";
import { PAGE_PROTOCOL, type PageBridge } from "../page-protocol.js";

const MAX_TEXT_NODES = 20_000;

export function createPageBridge(): PageBridge {
  const lifecycle = createPageLifecycle();
  const traversal = createDomTraversal({
    document,
    observe: lifecycle.observe,
  });
  const semantics = createElementSemantics({
    document,
    modalOrder: lifecycle.modalOrder,
    composedParent: traversal.composedParent,
    allElements: traversal.allElements,
    flatTextNodes: traversal.flatTextNodes,
  });
  const names = createCandidateNames({
    ...traversal,
    ...semantics,
  });
  const hover = createHoverDiscovery({
    composedParent: traversal.composedParent,
    interactive: semantics.interactive,
    visible: semantics.visible,
  });
  const context = createCandidateContext({
    document,
    composedParent: traversal.composedParent,
    allElements: traversal.allElements,
    visible: semantics.visible,
    interactive: semantics.interactive,
    pointerTarget: semantics.pointerTarget,
    publicText: semantics.publicText,
    excludedTextAncestor: semantics.excludedTextAncestor,
    hoverRevealed: hover.revealed,
    label: names.label,
    mediaName: names.mediaName,
    iconName: names.iconName,
  });
  const scanner = createCandidateScanner({
    document,
    documentId: lifecycle.documentId,
    version: lifecycle.version,
    sameVersion: lifecycle.sameVersion,
    modal: semantics.modal,
    allElements: traversal.allElements,
    resetContext: context.reset,
    resetHover: hover.reset,
    observeHeading: context.observeHeading,
    visible: semantics.visible,
    transparentToggle: semantics.transparentToggle,
    ariaHiddenOnly: semantics.ariaHiddenOnly,
    hoverHost: hover.host,
    toggleLabel: semantics.toggleLabel,
    readable: semantics.readable,
    interactive: semantics.interactive,
    pointerTarget: semantics.pointerTarget,
    editable: semantics.editable,
    role: semantics.role,
    label: names.label,
    candidateName: names.candidateName,
    boundedName: context.boundedName,
    peers: context.peers,
    locationOf: context.locationOf,
    sectionOf: context.sectionOf,
    nameHint: names.nameHint,
    disabled: semantics.disabled,
    inArticleBody: context.inArticleBody,
    path: context.path,
  });
  const pageText = createPageText({
    version: lifecycle.version,
    modal: semantics.modal,
    visible: semantics.visible,
    excludedTextAncestor: semantics.excludedTextAncestor,
    label: names.label,
    countBadgeKind: names.countBadgeKind,
    maxTextNodes: MAX_TEXT_NODES,
  });
  const actions = createTargetActions({
    document,
    snapshot: scanner.snapshot,
    version: lifecycle.version,
    sameVersion: lifecycle.sameVersion,
    rawName: scanner.rawName,
    allElements: traversal.allElements,
    candidateName: names.candidateName,
    peers: context.peers,
    editable: semantics.editable,
    readable: semantics.readable,
    visible: semantics.visible,
    disabled: semantics.disabled,
    label: names.label,
    publicText: semantics.publicText,
    toggleLabel: semantics.toggleLabel,
    isToggle: semantics.isToggle,
    deepContains: traversal.deepContains,
    hoverHost: hover.host,
    transparentToggle: semantics.transparentToggle,
    ariaHiddenOnly: semantics.ariaHiddenOnly,
    deepElementFromPoint: traversal.deepElementFromPoint,
    viewport: () => ({ width: innerWidth, height: innerHeight }),
  });
  const visualCandidates = createVisualCandidates({
    version: lifecycle.version,
    sameVersion: lifecycle.sameVersion,
    snapshot: scanner.snapshot,
    refElement: actions.refElement,
    visible: semantics.visible,
    disabled: semantics.disabled,
    deepElementFromPoint: traversal.deepElementFromPoint,
    deepContains: traversal.deepContains,
  });

  return createBridge(lifecycle, scanner, pageText, actions, visualCandidates);
}

function createBridge(
  lifecycle: ReturnType<typeof createPageLifecycle>,
  scanner: ReturnType<typeof createCandidateScanner>,
  pageText: ReturnType<typeof createPageText>,
  actions: ReturnType<typeof createTargetActions>,
  visualCandidates: PageBridge["visualCandidates"],
): PageBridge {
  return {
    protocol: PAGE_PROTOCOL,
    visualCandidates,
    collect: scanner.collect,
    digest: pageText.digest,
    visibleText: pageText.visibleText,
    pageVersion: lifecycle.version,
    findBySignals: ({ operation }) => {
      const first = scanner.collect({ operation });
      return { ...first, candidates: scanner.candidates(), next: null };
    },
    clickTarget: (ref) => actions.aim(ref),
    readTarget: actions.readTarget,
    controlState: actions.controlState,
    checkAim: (expected) => actions.aim(expected.ref, expected),
    hoverElement: actions.hoverElement,
    fillElement: actions.fillElement,
    clearRefs: scanner.clearRefs,
    quiet: ({ ms, timeoutMs }) => lifecycle.quiet(ms, timeoutMs),
  };
}
