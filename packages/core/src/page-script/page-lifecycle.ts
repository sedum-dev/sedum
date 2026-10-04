import type { PageVersion } from "../page-protocol.js";

export function createPageLifecycle() {
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)))
    .map((part) => part.toString(16))
    .join("-");
  let revision = 0;
  let route = location.href;
  const modalOrder = new Map<HTMLDialogElement, number>();
  let modalSequence = 0;
  const observed = new WeakSet<Node>();

  function trackDialog(change: MutationRecord): void {
    if (change.type !== "attributes" || change.attributeName !== "open") return;
    if (!(change.target instanceof HTMLDialogElement)) return;
    if (change.oldValue === null && change.target.matches(":modal")) {
      modalOrder.set(change.target, ++modalSequence);
    } else if (!change.target.open) {
      modalOrder.delete(change.target);
    }
  }

  function changesRevision(change: MutationRecord): boolean {
    return (
      change.type !== "attributes" || change.attributeName !== "data-sedum-ref"
    );
  }

  const observer = new MutationObserver((changes) => {
    changes.forEach(trackDialog);
    if (changes.some(changesRevision)) revision++;
  });

  function observe(root: Document | ShadowRoot): void {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
    });
  }

  function version(): PageVersion {
    if (route !== location.href) {
      route = location.href;
      revision++;
    }
    return { document: documentId, revision, route };
  }

  function sameVersion(a: PageVersion, b: PageVersion): boolean {
    return (
      a.document === b.document &&
      a.revision === b.revision &&
      a.route === b.route
    );
  }

  async function quiet(
    ms: number,
    timeoutMs: number,
  ): Promise<{ version: PageVersion; quiet: boolean }> {
    const started = performance.now();
    let stable = started;
    let last = version();
    while (performance.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, ms)));
      const now = version();
      if (!sameVersion(last, now)) {
        last = now;
        stable = performance.now();
      }
      if (performance.now() - stable >= ms)
        return { version: now, quiet: true };
    }
    return { version: version(), quiet: false };
  }

  observe(document);
  return { documentId, modalOrder, observe, version, sameVersion, quiet };
}
