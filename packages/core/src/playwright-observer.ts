import { createHash, randomUUID } from "node:crypto";
import type { ElementHandle, Locator, Page } from "playwright-core";
import {
  MAX_DIGEST_POINTS,
  MAX_SNAPSHOT_BYTES,
  codePoints,
  parseSnapshot,
  projectSnapshot,
  type CandidateSpec,
  type ObservationOperation,
  type ObservedCandidate,
  type PageObservation,
  type ObservationVersion,
} from "./snapshot-observation.js";

export type ObservedClickResult =
  | { readonly clicked: true }
  | {
      readonly clicked: false;
      readonly reason:
        "stale" | "target_missing" | "not_actionable" | "action_started";
      readonly retryable: boolean;
    };

interface Lease {
  readonly candidate: ObservedCandidate;
  readonly handle: ElementHandle<Element>;
  readonly version: ObservationVersion;
  readonly domSignature: string;
}

function incomplete(
  reason: NonNullable<PageObservation["reason"]>,
): PageObservation {
  return { complete: false, reason, candidates: [] };
}

function reasonFrom(error: unknown): NonNullable<PageObservation["reason"]> {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("candidate_set_incomplete"))
    return "candidate_set_incomplete";
  if (
    text.includes("resource_ceiling") ||
    text.includes("candidate_field_too_large")
  )
    return "resource_ceiling";
  if (text.includes("mapping_ambiguous")) return "mapping_ambiguous";
  if (text.includes("scope_ambiguous")) return "scope_ambiguous";
  if (text.includes("not_quiet")) return "not_quiet";
  return "snapshot_invalid";
}

function targetLocator(scope: Page | Locator, spec: CandidateSpec): Locator {
  if (spec.role === "paragraph")
    return scope.getByText(spec.name, { exact: true });
  return scope.getByRole(spec.role as Parameters<Page["getByRole"]>[0], {
    name: spec.name,
    exact: true,
  });
}

function locatorFor(page: Page, spec: CandidateSpec): Locator {
  if (!spec.itemRole || (!spec.itemHeading && !spec.itemText))
    return targetLocator(page, spec);
  const region = page.getByRole(
    spec.itemRole as Parameters<Page["getByRole"]>[0],
  );
  const item = spec.itemHeading
    ? region.filter({
        has: page.getByRole("heading", { name: spec.itemHeading, exact: true }),
      })
    : region.filter({ hasText: spec.itemText! });
  return targetLocator(item, spec);
}

async function signalsFor(
  handle: ElementHandle<Element>,
): Promise<ObservedCandidate["signals"] & { tag: string }> {
  return handle.evaluate((element) => {
    const segments: string[] = [];
    for (
      let node: Element | null = element;
      node && segments.length < 12;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(node) : 0;
      segments.push(`${node.tagName.toLowerCase()}:${index}`);
    }
    const input =
      element instanceof HTMLInputElement ? element.type : undefined;
    return {
      tag: element.tagName.toLowerCase(),
      path: segments.reverse().join("/"),
      ...(element.getAttribute("data-testid")
        ? { hook: element.getAttribute("data-testid")! }
        : {}),
      ...(element.id ? { id: element.id } : {}),
      ...(input ? { inputType: input } : {}),
      ...(element.getAttribute("href")
        ? { href: element.getAttribute("href")! }
        : {}),
    };
  });
}

function domSignature(handle: ElementHandle<Element>): Promise<string> {
  return handle
    .evaluate((element) => {
      const ancestors: string[][] = [];
      let bytes = 0;
      for (
        let current: Element | null = element;
        current && ancestors.length < 12;
        current = current.parentElement
      ) {
        const attributes = Array.from(
          current.attributes,
          (attribute) => `${attribute.name}=${attribute.value}`,
        ).sort();
        bytes += attributes.reduce(
          (total, attribute) => total + attribute.length,
          0,
        );
        if (bytes > 16_384 || attributes.length > 64)
          throw new Error("resource_ceiling");
        ancestors.push([current.tagName.toLowerCase(), ...attributes]);
      }
      return ancestors.map((attributes) => attributes.join("\0")).join("\n");
    })
    .then((value) => createHash("sha256").update(value).digest("hex"));
}

/** Match a flattened ARIA neighbor to one live control using bounded card text. */
async function handleByContext(
  locator: Locator,
  peer: string,
): Promise<ElementHandle<Element>> {
  const handles = (await locator.elementHandles()) as ElementHandle<Element>[];
  const matches: ElementHandle<Element>[] = [];
  try {
    for (const handle of handles) {
      const matchesPeer = await handle.evaluate((element, expected) => {
        for (
          let ancestor = element.parentElement, depth = 0;
          ancestor && depth < 6;
          ancestor = ancestor.parentElement, depth++
        ) {
          const walker = document.createTreeWalker(
            ancestor,
            NodeFilter.SHOW_TEXT,
          );
          const pieces: string[] = [];
          let visited = 0;
          while (walker.nextNode()) {
            if (++visited > 200) return false;
            const textNode = walker.currentNode;
            const parent = textNode.parentElement;
            if (
              !parent ||
              parent.closest(
                "button,a,input,textarea,select,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true']",
              )
            )
              continue;
            const text = (textNode.textContent ?? "")
              .replace(/\s+/gu, " ")
              .trim();
            if (text && !/^[\p{Sc}\d.,\s%+-]+$/u.test(text)) pieces.push(text);
            if (pieces.join(" ").length > 512) return false;
          }
          if (pieces.length) return pieces.join(" ").includes(expected);
        }
        return false;
      }, peer);
      if (matchesPeer) matches.push(handle);
    }
    if (matches.length !== 1) throw new Error("mapping_ambiguous");
    const selected = matches[0]!;
    await Promise.all(
      handles
        .filter((handle) => handle !== selected)
        .map((handle) => handle.dispose().catch(() => undefined)),
    );
    return selected;
  } catch (error) {
    await Promise.all(
      handles.map((handle) => handle.dispose().catch(() => undefined)),
    );
    throw error;
  }
}

async function visibleDigest(page: Page, modalScope: boolean): Promise<string> {
  const result: unknown = await page.evaluate((modal) => {
    const started = performance.now();
    const root = modal
      ? document.querySelector(
          "dialog:modal, [role='dialog'][aria-modal='true']",
        )
      : document.body;
    if (!root) return { complete: true, text: "" };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let nodes = 0;
    let length = 0;
    while (walker.nextNode()) {
      if (++nodes > 20_000 || performance.now() - started > 2000)
        return { complete: false, text: "" };
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      if (
        parent.closest(
          "script,style,template,[hidden],[inert],[aria-hidden='true'],input,textarea,select,[contenteditable]:not([contenteditable='false']),dialog:not([open])",
        )
      )
        continue;
      let visible = true;
      for (
        let element: Element | null = parent;
        element;
        element = element.parentElement
      ) {
        const style = getComputedStyle(element);
        if (
          style.display === "none" ||
          style.contentVisibility === "hidden" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity) === 0
        ) {
          visible = false;
          break;
        }
      }
      if (!visible) continue;
      const text = (node.textContent ?? "").replace(/\s+/gu, " ").trim();
      if (!text) continue;
      length += Array.from(text).length + (parts.length ? 1 : 0);
      if (length > 4096) return { complete: false, text: "" };
      parts.push(text);
    }
    return { complete: true, text: parts.join(" ") };
  }, modalScope);
  if (!result || typeof result !== "object")
    throw new Error("digest_incomplete");
  const value = result as { complete?: unknown; text?: unknown };
  if (
    value.complete !== true ||
    typeof value.text !== "string" ||
    codePoints(value.text) > MAX_DIGEST_POINTS
  )
    throw new Error("digest_incomplete");
  return value.text;
}

export class PlaywrightObserver {
  private readonly leases = new Map<string, Lease>();
  private selectedId: string | undefined;
  private documentEpoch = 0;
  private route = "";

  constructor(private readonly page: Page) {
    this.route = page.url();
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.documentEpoch++;
        void this.clear();
      }
    });
    page.on("close", () => {
      void this.clear();
    });
  }

  private async clear(keepSelected = false): Promise<void> {
    const retained = keepSelected ? this.selectedId : undefined;
    const disposing: Promise<void>[] = [];
    for (const [id, lease] of this.leases) {
      if (id === retained) continue;
      this.leases.delete(id);
      disposing.push(lease.handle.dispose().catch(() => undefined));
    }
    if (!keepSelected) this.selectedId = undefined;
    await Promise.all(disposing);
  }

  private checkRoute(): void {
    const current = this.page.url();
    if (current !== this.route) {
      this.route = current;
      void this.clear();
    }
  }

  private async snapshot(): Promise<{
    raw: unknown;
    version: ObservationVersion;
    modalScope: boolean;
  }> {
    this.checkRoute();
    const modal = this.page.locator(
      "dialog:modal, [role='dialog'][aria-modal='true']",
    );
    const modalCount = await modal.count();
    if (modalCount > 1) throw new Error("scope_ambiguous");
    const options = {
      mode: "default",
      signal: AbortSignal.timeout(3000),
    } as const;
    const raw: unknown =
      modalCount === 1
        ? await modal.ariaSnapshotJSON(options)
        : await this.page.ariaSnapshotJSON(options);
    const serialized = JSON.stringify(raw);
    if (!serialized || Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES)
      throw new Error("resource_ceiling");
    parseSnapshot(raw);
    return {
      raw,
      modalScope: modalCount === 1,
      version: {
        document: this.documentEpoch,
        route: this.page.url(),
        signature: createHash("sha256").update(serialized).digest("hex"),
      },
    };
  }

  async quiet(stableMs = 100, timeoutMs = 1000): Promise<boolean> {
    const started = performance.now();
    let stableSince = started;
    let previous = (await this.snapshot()).version;
    while (performance.now() - started < timeoutMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const current = (await this.snapshot()).version;
      if (
        current.document !== previous.document ||
        current.route !== previous.route ||
        current.signature !== previous.signature
      )
        stableSince = performance.now();
      if (performance.now() - stableSince >= stableMs) return true;
      previous = current;
    }
    return false;
  }

  async observe(operation: ObservationOperation): Promise<PageObservation> {
    await this.clear(true);
    try {
      const started = performance.now();
      if (!(await this.quiet())) throw new Error("not_quiet");
      const { raw, version, modalScope } = await this.snapshot();
      const specs = projectSnapshot(parseSnapshot(raw), operation);
      const digest = await visibleDigest(this.page, modalScope);
      const candidates: ObservedCandidate[] = [];
      const specCounts = new Map<string, number>();
      for (const spec of specs) {
        const key = `${spec.role}\0${spec.name}`;
        specCounts.set(key, (specCounts.get(key) ?? 0) + 1);
      }
      for (const spec of specs) {
        if (performance.now() - started > 5000)
          throw new Error("resource_ceiling");
        const direct = targetLocator(this.page, spec);
        const directCount = await direct.count();
        if (directCount !== specCounts.get(`${spec.role}\0${spec.name}`))
          throw new Error("mapping_ambiguous");
        let handle: ElementHandle<Element>;
        if (directCount === 1)
          handle = await direct.elementHandle({ timeout: 1000 });
        else {
          const scoped = locatorFor(this.page, spec);
          if (scoped !== direct && (await scoped.count()) === 1)
            handle = await scoped.elementHandle({ timeout: 1000 });
          else if (spec.fallbackPeer)
            handle = await handleByContext(direct, spec.fallbackPeer);
          else throw new Error("mapping_ambiguous");
        }
        try {
          const evidence = await signalsFor(handle);
          const candidate: ObservedCandidate = {
            id: randomUUID(),
            tag: evidence.tag,
            role: spec.role,
            name: spec.name,
            peers: spec.peers,
            editable: spec.editable,
            disabled: spec.disabled,
            signals: {
              path: evidence.path,
              ...(evidence.hook ? { hook: evidence.hook } : {}),
              ...(evidence.id ? { id: evidence.id } : {}),
              ...(evidence.inputType ? { inputType: evidence.inputType } : {}),
              ...(evidence.href ? { href: evidence.href } : {}),
            },
          };
          candidates.push(candidate);
          this.leases.set(candidate.id, {
            candidate,
            handle,
            version,
            domSignature: await domSignature(handle),
          });
        } catch (error) {
          await handle.dispose();
          throw error;
        }
      }
      const after = await this.snapshot();
      if (
        after.version.document !== version.document ||
        after.version.route !== version.route ||
        after.version.signature !== version.signature
      )
        throw new Error("snapshot_invalid");
      return { complete: true, version, candidates, digest };
    } catch (error) {
      await this.clear();
      if (error instanceof Error && error.message === "digest_incomplete")
        return incomplete("digest_incomplete");
      return incomplete(reasonFrom(error));
    }
  }

  select(id: string): boolean {
    if (!this.leases.has(id)) return false;
    this.selectedId = id;
    return true;
  }

  private async fresh(
    lease: Lease,
    requireReceiver = true,
  ): Promise<ObservedClickResult | undefined> {
    try {
      const { version } = await this.snapshot();
      if (
        version.document !== lease.version.document ||
        version.route !== lease.version.route ||
        version.signature !== lease.version.signature
      )
        return { clicked: false, reason: "stale", retryable: true };
      if ((await domSignature(lease.handle)) !== lease.domSignature)
        return { clicked: false, reason: "stale", retryable: true };
      const state = await lease.handle.evaluate((element, hitRequired) => {
        if (!element.isConnected || element.ownerDocument !== document)
          return "missing";
        if (
          element.matches(":disabled,[aria-disabled='true']") ||
          element.closest("[aria-disabled='true']")
        )
          return "disabled";
        const bounds = element.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        if (!bounds.width || !bounds.height) return "occluded";
        if (hitRequired) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
            return "occluded";
          const receiver = document.elementFromPoint(x, y);
          if (
            !receiver ||
            (receiver !== element && !element.contains(receiver))
          )
            return "occluded";
        }
        const enclosingLink = element.closest("a[href]");
        if (enclosingLink) {
          if (enclosingLink !== element) return "occluded";
          if (
            enclosingLink instanceof HTMLAnchorElement &&
            (enclosingLink.download ||
              !["", "_self"].includes(enclosingLink.target) ||
              !["http:", "https:"].includes(
                new URL(enclosingLink.href).protocol,
              ))
          )
            return "occluded";
        }
        return "ready";
      }, requireReceiver);
      if (state === "missing")
        return { clicked: false, reason: "target_missing", retryable: true };
      if (state !== "ready")
        return { clicked: false, reason: "not_actionable", retryable: true };
      return undefined;
    } catch {
      return { clicked: false, reason: "stale", retryable: true };
    }
  }

  async click(id: string): Promise<ObservedClickResult> {
    const lease = this.leases.get(id);
    if (!lease)
      return { clicked: false, reason: "target_missing", retryable: true };
    this.selectedId = id;
    try {
      const before = await this.fresh(lease, false);
      if (before) return before;
      try {
        await lease.handle.scrollIntoViewIfNeeded({ timeout: 1000 });
        await lease.handle.waitForElementState("stable", { timeout: 1000 });
      } catch {
        return { clicked: false, reason: "not_actionable", retryable: true };
      }
      const ready = await this.fresh(lease);
      if (ready) return ready;
      try {
        await lease.handle.click({ timeout: 1000 });
        return { clicked: true };
      } catch {
        return { clicked: false, reason: "action_started", retryable: false };
      }
    } finally {
      this.selectedId = undefined;
      await this.clear();
    }
  }

  async dispose(): Promise<void> {
    await this.clear();
  }
}
