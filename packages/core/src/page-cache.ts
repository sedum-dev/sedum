import { createHmac } from "node:crypto";
import {
  codePoints,
  isSafeRole,
  isWeakPeer,
  NAME_LIMIT,
  PEER_LIMIT,
  type Candidate,
  type CandidatePage,
  type Operation,
} from "./page-protocol.js";
import {
  boundedContextCandidate,
  contestedControlNoun,
  contextClues,
  words,
} from "./sentence-context.js";

export const CACHE_FORMAT = 1;
export const MATCHER_VERSION = 3;
export type CacheMissReason =
  | "absent"
  /** The target has no signal that can safely find it again, such as an input button. */
  | "not_cacheable"
  | "disabled"
  | "ci_default"
  | "outside_git"
  | "runtime_dependent"
  | "format_mismatch"
  | "matcher_mismatch"
  | "corrupt"
  | "storage_error"
  | "conflict"
  | "target_missing"
  | "strong_signal_conflict"
  | "low_score"
  | "near_tie"
  /** Another current control also fits the sentence's description of the target. */
  | "context_not_unique"
  | "candidate_set_incomplete"
  | "not_actionable";
export interface CacheEntry {
  readonly format: number;
  readonly matcher: number;
  readonly pageKey: string;
  readonly tag: string;
  readonly role: string;
  readonly inputType: string;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly path: string;
  /** Admitted by a unique ID and its own full item context; rechecked on every match. */
  readonly boundedContext?: boolean;
  readonly digests: {
    readonly hook?: string;
    readonly id?: string;
    readonly name?: string;
    readonly label?: string;
    readonly href?: string;
    readonly peers: readonly string[];
  };
}
export type MatchResult =
  | { readonly hit: true; readonly candidate: Candidate }
  | { readonly hit: false; readonly reason: CacheMissReason };

const HASH = /^[a-f0-9]{64}$/u;
const DIGEST_FIELDS = ["hook", "id", "name", "label", "href"] as const;

function validDigest(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function validRole(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value === "" || isSafeRole(value);
}

function validPeers(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > 2) return false;
  return value.every(validDigest);
}

function validOptionalDigests(digests: Record<string, unknown>): boolean {
  return DIGEST_FIELDS.every((field) => {
    const value = digests[field];
    return value === undefined || validDigest(value);
  });
}

function validDigests(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const digests = value as Record<string, unknown>;
  return validPeers(digests.peers) && validOptionalDigests(digests);
}

const ENTRY_VALIDATORS = [
  (item: Record<string, unknown>) => validDigest(item.pageKey),
  (item: Record<string, unknown>) => typeof item.tag === "string",
  (item: Record<string, unknown>) => validRole(item.role),
  (item: Record<string, unknown>) => typeof item.path === "string",
  (item: Record<string, unknown>) => typeof item.inputType === "string",
  (item: Record<string, unknown>) => typeof item.editable === "boolean",
  (item: Record<string, unknown>) => typeof item.disabled === "boolean",
  (item: Record<string, unknown>) =>
    item.boundedContext === undefined ||
    typeof item.boundedContext === "boolean",
  (item: Record<string, unknown>) => validDigests(item.digests),
] as const;

function validEntry(value: CacheEntry): boolean {
  const item = value as unknown as Record<string, unknown>;
  return ENTRY_VALIDATORS.every((validate) => validate(item));
}

export function normalizeSignal(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}
export function keyedDigest(key: Uint8Array, value: string): string {
  if (key.byteLength !== 32)
    throw new RangeError("Cache HMAC key must be 256 bits");
  return createHmac("sha256", key).update(normalizeSignal(value)).digest("hex");
}
export function pageKey(
  key: Uint8Array,
  route: string,
  operation: Operation,
  sentence: string,
): string {
  const url = new URL(route);
  return keyedDigest(
    key,
    JSON.stringify([
      url.origin,
      url.pathname,
      url.search,
      url.hash,
      operation,
      normalizeSignal(sentence),
    ]),
  );
}
function hasTargetContext(
  sentence: string,
  candidate: Candidate,
  candidates: readonly Candidate[],
): boolean {
  const contextWords = new Set(words(candidate.peers[0] ?? ""));
  return contextClues(sentence, candidate, candidates).some((word) =>
    contextWords.has(word),
  );
}

interface CacheIdentity {
  readonly key: Uint8Array;
  readonly route: string;
  readonly operation: Operation;
  readonly sentence: string;
}

interface StageRequest extends CacheIdentity {
  readonly candidate: Candidate;
  readonly eligible: CandidatePage;
}

type StageEntryArguments = readonly [
  key: Uint8Array,
  route: string,
  operation: Operation,
  sentence: string,
  candidate: Candidate,
  eligible: CandidatePage,
];

function unsafeRole(candidate: Candidate): boolean {
  if (candidate.role === "") return false;
  return !isSafeRole(candidate.role);
}

const CANDIDATE_BOUND_VIOLATIONS = [
  (candidate: Candidate) => !!candidate.signals.nameTruncated,
  (candidate: Candidate) => codePoints(candidate.name) > NAME_LIMIT,
  unsafeRole,
  (candidate: Candidate) => candidate.peers.length > 2,
  (candidate: Candidate) =>
    candidate.peers.some((peer) => codePoints(peer) > PEER_LIMIT),
] as const;

function assertCandidateBounds(candidate: Candidate): void {
  const exceedsBounds = CANDIDATE_BOUND_VIOLATIONS.some((violated) =>
    violated(candidate),
  );
  if (exceedsBounds)
    throw new RangeError("Candidate exceeds cache signal bounds");
}

function isInputButton(candidate: Candidate): boolean {
  return candidate.tag === "input" && !candidate.editable;
}

function repeatedCandidate(
  candidate: Candidate,
  eligible: CandidatePage,
): boolean {
  const normalizedName = candidate.name.trim().toLocaleLowerCase();
  return eligible.candidates.some((other) => {
    if (other.ref === candidate.ref) return false;
    if (other.name.trim().toLocaleLowerCase() === normalizedName) return true;
    if (!candidate.signals.href) return false;
    return other.signals.href === candidate.signals.href;
  });
}

function contextualCandidate(request: StageRequest): boolean {
  const { candidate, eligible, sentence } = request;
  if (!candidate.signals.contextComplete) return false;
  const peer = candidate.peers[0];
  if (!peer || isWeakPeer(peer)) return false;
  return hasTargetContext(sentence, candidate, eligible.candidates);
}

function hasStableSignal(candidate: Candidate): boolean {
  if (candidate.signals.hook) return true;
  if (candidate.signals.id) return true;
  return !!candidate.signals.name && !!candidate.name;
}

function unqualifiedIdentity(request: StageRequest): boolean {
  const { candidate, eligible, sentence } = request;
  if (repeatedCandidate(candidate, eligible)) return false;
  if (contextClues(sentence, candidate, eligible.candidates).length > 0)
    return false;
  return hasStableSignal(candidate);
}

function boundedAdmission(request: StageRequest): boolean {
  if (contextualCandidate(request)) return false;
  const { candidate, eligible, sentence } = request;
  return boundedContextCandidate(candidate, eligible.candidates, sentence);
}

function assertDistinguishable(request: StageRequest): void {
  if (contextualCandidate(request)) return;
  if (boundedAdmission(request)) return;
  if (unqualifiedIdentity(request)) return;
  throw new Error("candidate_not_distinguishable");
}

function digestField(
  field: "hook" | "id" | "name" | "label" | "href",
  value: string | undefined,
  key: Uint8Array,
): Partial<CacheEntry["digests"]> {
  return value ? { [field]: keyedDigest(key, value) } : {};
}

function createEntry(request: StageRequest): CacheEntry {
  const { candidate, key, operation, route, sentence } = request;
  const signals = candidate.signals;
  return {
    format: CACHE_FORMAT,
    matcher: MATCHER_VERSION,
    pageKey: pageKey(key, route, operation, sentence),
    tag: candidate.tag,
    role: candidate.role,
    inputType: candidate.inputType,
    editable: candidate.editable,
    disabled: candidate.disabled,
    path: signals.path,
    ...(boundedAdmission(request) ? { boundedContext: true } : {}),
    digests: {
      ...digestField("hook", signals.hook, key),
      ...digestField("id", signals.id, key),
      ...digestField("name", signals.name, key),
      ...digestField("label", candidate.name, key),
      ...digestField("href", signals.href, key),
      peers: candidate.peers.slice(0, 2).map((peer) => keyedDigest(key, peer)),
    },
  };
}

function validEligibleSet(request: StageRequest): boolean {
  const { candidate, eligible, route } = request;
  if (!eligible.complete) return false;
  if (eligible.next !== null) return false;
  if (eligible.total !== eligible.candidates.length) return false;
  if (eligible.version.route !== route) return false;
  return (
    eligible.candidates.filter((item) => item.ref === candidate.ref).length ===
    1
  );
}

function stage(request: StageRequest): CacheEntry {
  const { candidate } = request;
  assertCandidateBounds(candidate);
  // An input button's displayed name is its value property. Do not retain even
  // a digest of it: the property may be changed with customer data at runtime.
  if (isInputButton(candidate))
    throw new Error("candidate_not_distinguishable");
  assertDistinguishable(request);
  const entry = createEntry(request);
  if (!validEligibleSet(request))
    throw new Error("candidate_not_distinguishable");
  const matched = match({
    ...request,
    entry,
    candidates: request.eligible.candidates,
    complete: true,
    runtimeDependent: false,
  });
  if (!matched.hit || matched.candidate.ref !== candidate.ref)
    throw new Error("candidate_not_distinguishable");
  return entry;
}

export function stageEntry(...args: StageEntryArguments): CacheEntry {
  const [key, route, operation, sentence, candidate, eligible] = args;
  return stage({
    key,
    route,
    operation,
    sentence,
    candidate,
    eligible,
  });
}
interface Score {
  score: number;
  conflict: boolean;
  identity: boolean;
}

interface ScoreRequest {
  readonly entry: CacheEntry;
  readonly candidate: Candidate;
  readonly key: Uint8Array;
}

interface MatchRequest extends CacheIdentity {
  readonly entry: CacheEntry | undefined;
  readonly candidates: readonly Candidate[];
  readonly complete: boolean;
  readonly runtimeDependent: boolean;
}

type MatchEntryArguments = readonly [
  entry: CacheEntry | undefined,
  key: Uint8Array,
  route: string,
  operation: Operation,
  sentence: string,
  candidates: readonly Candidate[],
  complete: boolean,
  runtimeDependent?: boolean,
];

interface RankedCandidate extends Score {
  readonly candidate: Candidate;
}

const EMPTY_SCORE: Readonly<Score> = {
  score: 0,
  conflict: false,
  identity: false,
};
const SIGNAL_SCORES = [
  ["hook", 8, true],
  ["id", 8, true],
  ["name", 3, false],
  ["label", 5, true],
  ["href", 4, false],
] as const;

function sameCandidateShape(entry: CacheEntry, candidate: Candidate): boolean {
  if (entry.tag !== candidate.tag) return false;
  if (entry.role !== candidate.role) return false;
  if (entry.inputType !== candidate.inputType) return false;
  if (entry.editable !== candidate.editable) return false;
  return entry.disabled === candidate.disabled;
}

function liveSignal(
  candidate: Candidate,
  field: (typeof SIGNAL_SCORES)[number][0],
): string | undefined {
  return field === "label" ? candidate.name : candidate.signals[field];
}

function applySignalScore(
  result: Score,
  request: ScoreRequest,
  signal: (typeof SIGNAL_SCORES)[number],
): void {
  const [field, weight, strong] = signal;
  const stored = request.entry.digests[field];
  if (!stored) return;
  const live = liveSignal(request.candidate, field);
  if (!live || stored !== keyedDigest(request.key, live)) {
    if (strong) result.conflict = true;
    return;
  }
  result.score += weight;
  result.identity = true;
}

function applyPeerScore(result: Score, request: ScoreRequest): void {
  const stored = request.entry.digests.peers;
  if (stored.length === 0) return;
  const live = new Set(
    request.candidate.peers.map((peer) => keyedDigest(request.key, peer)),
  );
  if (stored.some((peer) => !live.has(peer))) {
    result.conflict = true;
    return;
  }
  result.score += 5;
  result.identity = true;
}

function score(request: ScoreRequest): Score {
  const { candidate, entry } = request;
  if (candidate.signals.nameTruncated) return { ...EMPTY_SCORE };
  if (!sameCandidateShape(entry, candidate)) return { ...EMPTY_SCORE };
  const result: Score = { ...EMPTY_SCORE };
  for (const signal of SIGNAL_SCORES) applySignalScore(result, request, signal);
  applyPeerScore(result, request);
  if (entry.path === candidate.signals.path) result.score += 1;
  return result;
}

function entryMiss(request: MatchRequest): CacheMissReason | null {
  const { entry } = request;
  if (!entry) return "absent";
  if (request.runtimeDependent) return "target_missing";
  if (entry.format !== CACHE_FORMAT) return "format_mismatch";
  if (entry.matcher !== MATCHER_VERSION) return "matcher_mismatch";
  if (!validEntry(entry)) return "corrupt";
  const expected = pageKey(
    request.key,
    request.route,
    request.operation,
    request.sentence,
  );
  return entry.pageKey === expected ? null : "target_missing";
}

function rankedCandidates(request: MatchRequest): RankedCandidate[] {
  const entry = request.entry!;
  return request.candidates
    .map((candidate) => ({
      candidate,
      ...score({ entry, candidate, key: request.key }),
    }))
    .sort((left, right) => right.score - left.score);
}

type RankedRule = readonly [
  rejected: (
    best: RankedCandidate,
    runnerUp: RankedCandidate | undefined,
  ) => boolean,
  reason: CacheMissReason,
];

const RANKED_RULES: readonly RankedRule[] = [
  [(best) => best.score === 0, "target_missing"],
  [(best) => best.conflict, "strong_signal_conflict"],
  [(best) => best.candidate.disabled, "not_actionable"],
  [(best) => !best.identity || best.score < 8, "low_score"],
  [
    (best, runnerUp) =>
      runnerUp !== undefined && best.score - runnerUp.score < 2,
    "near_tie",
  ],
];

function rankedMiss(
  best: RankedCandidate,
  runnerUp: RankedCandidate | undefined,
): CacheMissReason | null {
  const rule = RANKED_RULES.find(([rejected]) => rejected(best, runnerUp));
  return rule?.[1] ?? null;
}

function rankedResult(ranked: readonly RankedCandidate[]): MatchResult {
  const best = ranked[0];
  if (!best) return { hit: false, reason: "target_missing" };
  const miss = rankedMiss(best, ranked[1]);
  if (miss) return { hit: false, reason: miss };
  return { hit: true, candidate: best.candidate };
}

function contextUnique(request: MatchRequest, candidate: Candidate): boolean {
  const { candidates, entry, sentence } = request;
  if (contestedControlNoun(sentence, candidate, candidates)) return false;
  if (!entry?.boundedContext) return true;
  return boundedContextCandidate(candidate, candidates, sentence);
}

function contextResult(
  request: MatchRequest,
  result: MatchResult,
): MatchResult {
  if (!result.hit) return result;
  return contextUnique(request, result.candidate)
    ? result
    : { hit: false, reason: "context_not_unique" };
}

function match(request: MatchRequest): MatchResult {
  const miss = entryMiss(request);
  if (miss) return { hit: false, reason: miss };
  if (!request.complete)
    return { hit: false, reason: "candidate_set_incomplete" };
  return contextResult(request, rankedResult(rankedCandidates(request)));
}

export function matchEntry(...args: MatchEntryArguments): MatchResult {
  const [
    entry,
    key,
    route,
    operation,
    sentence,
    candidates,
    complete,
    runtimeDependent = false,
  ] = args;
  return match({
    entry,
    key,
    route,
    operation,
    sentence,
    candidates,
    complete,
    runtimeDependent,
  });
}
