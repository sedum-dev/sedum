import type { PageBridge, PageVersion } from "../page-protocol.js";
import type { CandidateSnapshot } from "./candidate-scanner.js";

interface Dependencies {
  readonly version: () => PageVersion;
  readonly sameVersion: (a: PageVersion, b: PageVersion) => boolean;
  readonly snapshot: () => CandidateSnapshot | undefined;
  readonly refElement: (ref: string) => Element | null;
  readonly visible: (element: Element) => boolean;
  readonly disabled: (element: Element) => boolean;
  readonly deepElementFromPoint: (x: number, y: number) => Element | null;
  readonly deepContains: (ancestor: Element, node: Element) => boolean;
}

type VisualResult = ReturnType<PageBridge["visualCandidates"]>;
type VisualBox = VisualResult["boxes"][number];

export function createVisualCandidates(deps: Dependencies): () => VisualResult {
  return () => {
    const current = deps.version();
    const snapshot = deps.snapshot();
    if (!snapshot || !deps.sameVersion(snapshot.version, current))
      throw new Error("stale visual observation");
    return {
      version: current,
      width: innerWidth,
      height: innerHeight,
      boxes: snapshot.candidates.flatMap((candidate) => boxFor(candidate.ref)),
    };
  };

  function boxFor(ref: string): VisualBox[] {
    const element = deps.refElement(ref);
    if (!element) return [];
    if (!deps.visible(element)) return [];
    if (deps.disabled(element)) return [];
    const rect = element.getBoundingClientRect();
    if (!insideViewport(rect)) return [];
    const hit = deps.deepElementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!hit || !deps.deepContains(element, hit)) return [];
    return [
      {
        ref,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
    ];
  }

  function insideViewport(rect: DOMRect): boolean {
    if (rect.width <= 0) return false;
    if (rect.height <= 0) return false;
    if (rect.left < 0) return false;
    if (rect.top < 0) return false;
    return rect.right <= innerWidth && rect.bottom <= innerHeight;
  }
}
