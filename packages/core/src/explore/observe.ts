import type { BrowserPage } from "../browser-driver.js";
import { collectCandidates, pageDigest, quietPage } from "../page-bridge.js";
import type { Candidate, Operation, PageVersion } from "../page-protocol.js";
import { hashText } from "./random.js";
import type { TargetIdentity } from "./types.js";

/** One settled page state with its action space. */
export interface Observation {
  readonly url: string;
  /** Path and query; the origin is fixed for a run. */
  readonly route: string;
  readonly title: string;
  readonly text: string;
  readonly version: PageVersion;
  readonly clicks: readonly Candidate[];
  readonly fills: readonly Candidate[];
  /** Disabled buttons, such as a submit waiting for a sub-form; never clicked. */
  readonly disabled: readonly Candidate[];
  /** Route plus visible text: the identity of a page state. */
  readonly state: string;
}

const MAX_PAGES = 4;

function sameVersion(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.revision === b.revision &&
    a.route === b.route
  );
}

/** Every candidate for one operation, following the scanner's pages. */
export async function allCandidates(
  page: BrowserPage,
  operation: Operation,
): Promise<{ version: PageVersion; candidates: Candidate[] } | null> {
  const first = await collectCandidates(page, operation);
  const candidates = [...first.candidates];
  let next = first.next;
  for (let index = 1; next !== null && index < MAX_PAGES; index++) {
    const more = await collectCandidates(page, operation, next, first.version);
    if (!sameVersion(more.version, first.version)) return null;
    candidates.push(...more.candidates);
    next = more.next;
  }
  return { version: first.version, candidates };
}

/**
 * Path and query; plus the fragment when it is a hash route such as
 * `#/account` or `#!/account`, which single-page apps use as their path.
 */
export function routeOf(url: string): string {
  try {
    const parsed = new URL(url);
    const hashRoute = /^#!?\//u.test(parsed.hash) ? parsed.hash : "";
    return parsed.pathname + parsed.search + hashRoute;
  } catch {
    return url;
  }
}

/** The same-origin path of a link, or null when it leaves the origin. */
export function sameOriginHref(
  href: string | undefined,
  base: string,
): string | null | undefined {
  if (!href) return undefined;
  try {
    const target = new URL(href, base);
    if (!/^https?:$/u.test(target.protocol)) return null;
    return target.origin === new URL(base).origin
      ? target.pathname + target.search
      : null;
  } catch {
    return null;
  }
}

export function onOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function title(page: BrowserPage): Promise<string> {
  return page.title ? await page.title().catch(() => "") : "";
}

async function observeOnce(page: BrowserPage): Promise<Observation | null> {
  const digest = await pageDigest(page);
  const clicks = await allCandidates(page, "click");
  const fills = await allCandidates(page, "fill");
  if (!clicks || !fills) return null;
  if (
    !sameVersion(digest.version, clicks.version) ||
    !sameVersion(digest.version, fills.version)
  )
    return null;
  const route = routeOf(page.url);
  return {
    url: page.url,
    route,
    title: await title(page),
    text: digest.text,
    version: digest.version,
    clicks: clicks.candidates.filter((c) => !c.disabled && !c.editable),
    disabled: clicks.candidates.filter((c) => c.disabled && !c.editable),
    fills: fills.candidates.filter((c) => !c.disabled && c.editable),
    state: hashText(`${route}\n${digest.text}`),
  };
}

/** Observe a settled page; retries while the page is still changing. */
export async function observe(page: BrowserPage): Promise<Observation> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const observation = await observeOnce(page).catch(() => null);
    if (observation) return observation;
    await settle(page);
  }
  throw new Error("The page did not hold still long enough to observe.");
}

/** Wait for DOM quiet, after Bombadil's quiescence and Sedum's settling. */
export async function settle(page: BrowserPage): Promise<void> {
  await page
    .settle({ state: "domcontentloaded", timeoutMs: 4_000 })
    .catch(() => undefined);
  // Single-page apps fetch route code and data after the DOM goes quiet.
  await networkQuiet(page);
  await quietPage(page, 100, 1_500).catch(() => undefined);
}

interface InFlight {
  count: number;
  lastChange: number;
}

const inFlight = new WeakMap<object, InFlight>();

/** Count the page's pending requests, attaching listeners on first use. */
function trackRequests(page: BrowserPage): InFlight | undefined {
  const native = page.playwright?.().page;
  if (!native) return undefined;
  let state = inFlight.get(native);
  if (state) return state;
  const tracked: InFlight = { count: 0, lastChange: performance.now() };
  const change = (delta: number) => {
    tracked.count = Math.max(0, tracked.count + delta);
    tracked.lastChange = performance.now();
  };
  native.on("request", () => change(1));
  native.on("requestfinished", () => change(-1));
  native.on("requestfailed", () => change(-1));
  inFlight.set(native, tracked);
  state = tracked;
  return state;
}

/**
 * Wait until no request has been pending for `quietMs`. Best effort: pages
 * that poll or stream never go quiet, so this gives up after `timeoutMs`.
 */
async function networkQuiet(
  page: BrowserPage,
  quietMs = 300,
  timeoutMs = 3_000,
): Promise<void> {
  const state = trackRequests(page);
  if (!state) return;
  const deadline = performance.now() + timeoutMs;
  // Give a just-dispatched action a moment to start its requests.
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (performance.now() < deadline) {
    const idleFor = performance.now() - state.lastChange;
    if (state.count === 0 && idleFor >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sameGroup(a: Candidate, b: Candidate): boolean {
  return a.role === b.role && a.name === b.name && a.location === b.location;
}

/** Identity that survives a new observation or a fresh replay. */
export function identityOf(
  candidates: readonly Candidate[],
  candidate: Candidate,
  base: string,
): TargetIdentity {
  const group = candidates.filter((c) => sameGroup(c, candidate));
  const href = sameOriginHref(candidate.signals.href, base);
  return {
    role: candidate.role,
    name: candidate.name,
    ...(candidate.location ? { location: candidate.location } : {}),
    ...(candidate.peers[0] ? { peer: candidate.peers[0] } : {}),
    ...(href ? { href } : {}),
    ...(candidate.editable ? { inputType: candidate.inputType } : {}),
    occurrence: group.indexOf(candidate),
  };
}

/** Find a candidate by identity, or null when the page diverged. */
export function findByIdentity(
  candidates: readonly Candidate[],
  identity: TargetIdentity,
): Candidate | null {
  const named = candidates.filter(
    (c) => c.role === identity.role && c.name === identity.name,
  );
  const group = named.filter((c) => c.location === identity.location);
  const byPeer = identity.peer
    ? group.filter((c) => c.peers[0] === identity.peer)
    : [];
  if (byPeer.length === 1) return byPeer[0]!;
  // A moved but unique target still matches; anything else has diverged.
  return group[identity.occurrence] ?? (named.length === 1 ? named[0]! : null);
}
