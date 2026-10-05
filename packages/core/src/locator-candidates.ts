import type { BrowserPage } from "./browser-driver.js";
import { collectCandidates } from "./page-bridge.js";
import {
  CANDIDATE_LIMIT,
  NAME_LIMIT,
  PAGE_PROTOCOL,
  projectCandidates,
  type Candidate,
  type CandidatePage,
  type Operation,
  type PageVersion,
} from "./page-protocol.js";
import { LocatorError } from "./locator-error.js";

export const MAX_CANDIDATES = 4096;
const MAX_REQUEST_BYTES = 60 * 1024;

export function sameVersion(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.route === b.route &&
    a.revision === b.revision
  );
}

function invalidFirstPage(page: CandidatePage): boolean {
  return (
    !page.complete ||
    page.offset !== 0 ||
    page.total > MAX_CANDIDATES ||
    page.candidates.length > CANDIDATE_LIMIT
  );
}

function invalidNextPage(
  page: CandidatePage,
  first: CandidatePage,
  expectedOffset: number,
): boolean {
  return (
    !page.complete ||
    page.total !== first.total ||
    page.offset !== expectedOffset ||
    page.candidates.length === 0 ||
    page.candidates.length > CANDIDATE_LIMIT
  );
}

function addUnique(
  target: Candidate[],
  refs: Set<string>,
  candidates: readonly Candidate[],
): void {
  for (const candidate of candidates) {
    if (refs.has(candidate.ref)) throw new LocatorError("incomplete");
    refs.add(candidate.ref);
    target.push(candidate);
  }
}

function assertFirstPage(page: CandidatePage): void {
  if (!invalidFirstPage(page)) return;
  throw new LocatorError(
    page.total > MAX_CANDIDATES ? "resource_limit" : "incomplete",
  );
}

function assertInitialRefs(candidates: readonly Candidate[]): Set<string> {
  const refs = new Set(candidates.map((candidate) => candidate.ref));
  if (refs.size !== candidates.length) throw new LocatorError("incomplete");
  return refs;
}

function assertNextOffset(
  next: number,
  collected: readonly Candidate[],
  total: number,
): void {
  if (next !== collected.length || collected.length >= total)
    throw new LocatorError("incomplete");
}

function assertNextPage(
  part: CandidatePage,
  first: CandidatePage,
  next: number,
): void {
  if (!sameVersion(part.version, first.version))
    throw new LocatorError("stale");
  if (invalidNextPage(part, first, next)) throw new LocatorError("incomplete");
}

export async function fullSet(
  page: BrowserPage,
  operation: Operation,
): Promise<CandidatePage> {
  const first = await collectCandidates(page, operation);
  assertFirstPage(first);

  const collected = [...first.candidates];
  const refs = assertInitialRefs(collected);

  let next = first.next;
  while (next !== null) {
    assertNextOffset(next, collected, first.total);
    const part = await collectCandidates(page, operation, next, first.version);
    assertNextPage(part, first, next);
    addUnique(collected, refs, part.candidates);
    next = part.next;
  }

  if (collected.length !== first.total) throw new LocatorError("stale");
  return { ...first, next: null, candidates: collected };
}

export function requestOptions(
  candidates: readonly Candidate[],
): CandidatePage {
  return {
    protocol: PAGE_PROTOCOL,
    version: { document: "", route: "", revision: 0 },
    total: candidates.length,
    offset: 0,
    next: null,
    complete: true,
    candidates,
  };
}

function requestBytes(
  sentence: string,
  candidates: readonly Candidate[],
): number {
  try {
    const projected = projectCandidates(requestOptions(candidates));
    return Buffer.byteLength(
      JSON.stringify({
        sentence,
        options: [
          ...projected.map((candidate) => ({ kind: "candidate", candidate })),
          { kind: "none", id: "none" },
        ],
      }),
      "utf8",
    );
  } catch {
    throw new LocatorError("request_too_large");
  }
}

export function batches(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate[][] {
  const result: Candidate[][] = [];
  let batch: Candidate[] = [];
  for (const candidate of candidates) {
    const next = [...batch, candidate];
    const mustSplit =
      batch.length > 0 &&
      (batch.length === CANDIDATE_LIMIT ||
        requestBytes(sentence, next) > MAX_REQUEST_BYTES);
    if (mustSplit) {
      result.push(batch);
      batch = [];
    }
    batch.push(candidate);
    if (requestBytes(sentence, batch) > MAX_REQUEST_BYTES)
      throw new LocatorError("request_too_large");
  }
  if (batch.length) result.push(batch);
  return result;
}

function repeatedGroup(
  selected: Candidate,
  candidates: readonly Candidate[],
): Candidate[] {
  const name = selected.name.trim().toLocaleLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.name.trim().toLocaleLowerCase() === name ||
      (!!selected.signals.href &&
        candidate.signals.href === selected.signals.href),
  );
}

export function withSiblings(
  sentence: string,
  finalists: readonly Candidate[],
  candidates: readonly Candidate[],
): Candidate[] {
  const keep = new Set<Candidate>(finalists);
  for (const finalist of finalists)
    for (const sibling of repeatedGroup(finalist, candidates))
      keep.add(sibling);
  const ordered = candidates.filter((candidate) => keep.has(candidate));
  try {
    return batches(sentence, ordered).length === 1 ? ordered : [...finalists];
  } catch {
    return [...finalists];
  }
}

export function hintedCandidate(candidate: Candidate): Candidate {
  const hint = candidate.signals.nameHint;
  if (!hint) return candidate;
  const points = Array.from(`${candidate.name} (${hint})`);
  const name =
    points.length <= NAME_LIMIT
      ? points.join("")
      : points.slice(0, NAME_LIMIT - 1).join("") + "…";
  return { ...candidate, name };
}
