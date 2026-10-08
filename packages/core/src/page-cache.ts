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

export const CACHE_FORMAT = 1;
export const MATCHER_VERSION = 4;
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
  /** Incomplete item context admitted only with unique ID and full sentence clues. */
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
function words(value: string): string[] {
  return (
    normalizeSignal(value)
      .toLowerCase()
      .match(/\p{L}[\p{L}\p{N}]*/gu) ?? []
  );
}
function controlNoun(
  tokens: string[],
  index: number,
  name: string[],
  role: string,
): boolean {
  if (!["button", "link"].includes(role)) return false;
  if (tokens[index] !== role || name.length === 0) return false;
  if (index < name.length) return false;
  return tokens.slice(index - name.length, index).join(" ") === name.join(" ");
}
function contextClues(sentence: string, label: string, role: string): string[] {
  const labelWords = new Set(words(label));
  const commands = new Set([
    "add",
    "buy",
    "click",
    "press",
    "select",
    "choose",
    "open",
    "tap",
    "cart",
    "item",
    "product",
    "the",
    "and",
    "with",
    "for",
    "type",
    "fill",
    "enter",
    "write",
    "field",
    "input",
    "box",
  ]);
  const tokens = words(sentence.replace(/\{\{[^{}]+\}\}/gu, " "));
  const name = words(label);
  return tokens.filter(
    (word, index) =>
      !controlNoun(tokens, index, name, role) &&
      Array.from(word).length >= 3 &&
      !labelWords.has(word) &&
      !commands.has(word),
  );
}
function hasTargetContext(
  sentence: string,
  candidate: Candidate,
  context: string,
): boolean {
  const contextWords = new Set(words(context));
  return contextClues(sentence, candidate.name, candidate.role).some((word) =>
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
  const { candidate, sentence } = request;
  if (!candidate.signals.contextComplete) return false;
  const peer = candidate.peers[0];
  if (!peer || isWeakPeer(peer)) return false;
  return hasTargetContext(sentence, candidate, peer);
}

function hasStableSignal(candidate: Candidate): boolean {
  if (candidate.signals.hook) return true;
  if (candidate.signals.id) return true;
  return !!candidate.signals.name && !!candidate.name;
}

function boundedPeer(candidate: Candidate): string | undefined {
  const peer = candidate.peers[0];
  if (!peer) return;
  if (isWeakPeer(peer)) return;
  if (codePoints(peer) >= PEER_LIMIT) return;
  return peer;
}

function fullContextMatch(sentence: string, candidate: Candidate): boolean {
  const peer = boundedPeer(candidate);
  if (!peer) return false;
  const clues = contextClues(sentence, candidate.name, candidate.role);
  const context = new Set(words(peer));
  return clues.length > 0 && clues.every((clue) => context.has(clue));
}

function boundedContextCandidate(
  candidate: Candidate,
  candidates: readonly Candidate[],
  sentence: string,
): boolean {
  if (candidate.tag !== "button" || !candidate.signals.id) return false;
  if (!fullContextMatch(sentence, candidate)) return false;
  const sameId = candidates.filter(
    (other) => other.signals.id === candidate.signals.id,
  );
  const sameNamed = candidates.filter(
    (other) =>
      normalizeSignal(other.name).toLowerCase() ===
        normalizeSignal(candidate.name).toLowerCase() &&
      other.role === candidate.role,
  );
  // An unobserved or possibly truncated peer cannot establish contextual uniqueness.
  if (sameNamed.some((other) => !boundedPeer(other))) return false;
  const sameContext = sameNamed.filter((other) =>
    fullContextMatch(sentence, other),
  );
  return sameId.length === 1 && sameContext.length === 1;
}

function unqualifiedIdentity(request: StageRequest): boolean {
  return (
    !repeatedCandidate(request.candidate, request.eligible) &&
    contextClues(
      request.sentence,
      request.candidate.name,
      request.candidate.role,
    ).length === 0 &&
    hasStableSignal(request.candidate)
  );
}

function assertDistinguishable(request: StageRequest): void {
  const { candidate, eligible, sentence } = request;
  if (contextualCandidate(request)) return;
  if (boundedContextCandidate(candidate, eligible.candidates, sentence)) return;
  if (unqualifiedIdentity(request)) return;
  throw new Error("candidate_not_distinguishable");
}

function digestField(
  field: (typeof DIGEST_FIELDS)[number],
  value: string | undefined,
  key: Uint8Array,
): Partial<CacheEntry["digests"]> {
  return value ? { [field]: keyedDigest(key, value) } : {};
}

function createEntry(request: StageRequest): CacheEntry {
  const { candidate, key, operation, route, sentence } = request;
  const signals = candidate.signals;
  const boundedContext =
    !contextualCandidate(request) &&
    boundedContextCandidate(candidate, request.eligible.candidates, sentence);
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
    ...(boundedContext ? { boundedContext: true } : {}),
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

function match(request: MatchRequest): MatchResult {
  const miss = entryMiss(request);
  if (miss) return { hit: false, reason: miss };
  if (!request.complete)
    return { hit: false, reason: "candidate_set_incomplete" };
  const result = rankedResult(rankedCandidates(request));
  if (!result.hit || !request.entry?.boundedContext) return result;
  return boundedContextCandidate(
    result.candidate,
    request.candidates,
    request.sentence,
  )
    ? result
    : { hit: false, reason: "near_tie" };
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
