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
export const MATCHER_VERSION = 1;
export type CacheMissReason =
  | "absent"
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

function validEntry(value: CacheEntry): boolean {
  const item = value as unknown as Record<string, unknown>;
  const digests = item.digests as Record<string, unknown> | undefined;
  return (
    typeof item.pageKey === "string" &&
    /^[a-f0-9]{64}$/.test(item.pageKey) &&
    typeof item.tag === "string" &&
    typeof item.role === "string" &&
    (item.role === "" || isSafeRole(item.role)) &&
    typeof item.path === "string" &&
    typeof item.inputType === "string" &&
    typeof item.editable === "boolean" &&
    typeof item.disabled === "boolean" &&
    !!digests &&
    Array.isArray(digests.peers) &&
    digests.peers.length <= 2 &&
    digests.peers.every(
      (peer) => typeof peer === "string" && /^[a-f0-9]{64}$/.test(peer),
    ) &&
    ["hook", "id", "name", "label", "href"].every(
      (field) =>
        digests[field] === undefined ||
        (typeof digests[field] === "string" &&
          /^[a-f0-9]{64}$/.test(digests[field])),
    )
  );
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
function contextClues(sentence: string, label: string): string[] {
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
  return words(sentence.replace(/\{\{[^{}]+\}\}/gu, " ")).filter(
    (word) =>
      Array.from(word).length >= 3 &&
      !labelWords.has(word) &&
      !commands.has(word),
  );
}
function hasTargetContext(
  sentence: string,
  label: string,
  context: string,
): boolean {
  const contextWords = new Set(words(context));
  return contextClues(sentence, label).some((word) => contextWords.has(word));
}
export function stageEntry(
  key: Uint8Array,
  route: string,
  operation: Operation,
  sentence: string,
  candidate: Candidate,
  eligible: CandidatePage,
): CacheEntry {
  if (
    candidate.signals.nameTruncated ||
    codePoints(candidate.name) > NAME_LIMIT ||
    (candidate.role !== "" && !isSafeRole(candidate.role)) ||
    candidate.peers.length > 2 ||
    candidate.peers.some((peer) => codePoints(peer) > PEER_LIMIT)
  )
    throw new RangeError("Candidate exceeds cache signal bounds");
  // An input button's displayed name is its value property. Do not retain even
  // a digest of it: the property may be changed with customer data at runtime.
  if (candidate.tag === "input" && !candidate.editable)
    throw new Error("candidate_not_distinguishable");
  const repeated = eligible.candidates.some(
    (other) =>
      other.ref !== candidate.ref &&
      (other.name.trim().toLocaleLowerCase() ===
        candidate.name.trim().toLocaleLowerCase() ||
        (!!candidate.signals.href &&
          other.signals.href === candidate.signals.href)),
  );
  const contextual =
    candidate.signals.contextComplete &&
    !!candidate.peers[0] &&
    !isWeakPeer(candidate.peers[0]) &&
    hasTargetContext(sentence, candidate.name, candidate.peers[0]);
  if (
    (!contextual &&
      (repeated || contextClues(sentence, candidate.name).length > 0)) ||
    (!contextual &&
      !candidate.signals.hook &&
      !candidate.signals.id &&
      !(candidate.signals.name && candidate.name))
  )
    throw new Error("candidate_not_distinguishable");
  const signals = candidate.signals;
  const entry: CacheEntry = {
    format: CACHE_FORMAT,
    matcher: MATCHER_VERSION,
    pageKey: pageKey(key, route, operation, sentence),
    tag: candidate.tag,
    role: candidate.role,
    inputType: candidate.inputType,
    editable: candidate.editable,
    disabled: candidate.disabled,
    path: signals.path,
    digests: {
      ...(signals.hook ? { hook: keyedDigest(key, signals.hook) } : {}),
      ...(signals.id ? { id: keyedDigest(key, signals.id) } : {}),
      ...(signals.name ? { name: keyedDigest(key, signals.name) } : {}),
      ...(candidate.name ? { label: keyedDigest(key, candidate.name) } : {}),
      ...(signals.href ? { href: keyedDigest(key, signals.href) } : {}),
      peers: candidate.peers.slice(0, 2).map((peer) => keyedDigest(key, peer)),
    },
  };
  if (
    !eligible.complete ||
    eligible.next !== null ||
    eligible.total !== eligible.candidates.length ||
    eligible.version.route !== route ||
    eligible.candidates.filter((item) => item.ref === candidate.ref).length !==
      1
  )
    throw new Error("candidate_not_distinguishable");
  const matched = matchEntry(
    entry,
    key,
    route,
    operation,
    sentence,
    eligible.candidates,
    true,
  );
  if (!matched.hit || matched.candidate.ref !== candidate.ref)
    throw new Error("candidate_not_distinguishable");
  return entry;
}
function score(
  entry: CacheEntry,
  candidate: Candidate,
  key: Uint8Array,
): { score: number; conflict: boolean; identity: boolean } {
  if (candidate.signals.nameTruncated)
    return { score: 0, conflict: false, identity: false };
  if (
    entry.tag !== candidate.tag ||
    entry.role !== candidate.role ||
    entry.inputType !== candidate.inputType ||
    entry.editable !== candidate.editable ||
    entry.disabled !== candidate.disabled
  )
    return { score: 0, conflict: false, identity: false };
  let points = 0;
  let identity = false;
  let conflict = false;
  const stored = entry.digests;
  const live = candidate.signals;
  for (const [field, weight, strong] of [
    ["hook", 8, true],
    ["id", 8, true],
    ["name", 3, false],
    ["label", 5, true],
    ["href", 4, false],
  ] as const) {
    const old = stored[field];
    if (!old) continue;
    const raw = field === "label" ? candidate.name : live[field];
    if (!raw || old !== keyedDigest(key, raw)) {
      if (strong) conflict = true;
      continue;
    }
    points += weight;
    identity = true;
  }
  if (stored.peers.length) {
    const peerHashes = new Set(
      candidate.peers.map((peer) => keyedDigest(key, peer)),
    );
    if (stored.peers.some((peer) => !peerHashes.has(peer))) conflict = true;
    else {
      points += 5;
      identity = true;
    }
  }
  if (entry.path === candidate.signals.path) points += 1;
  return { score: points, conflict, identity };
}
export function matchEntry(
  entry: CacheEntry | undefined,
  key: Uint8Array,
  route: string,
  operation: Operation,
  sentence: string,
  candidates: readonly Candidate[],
  complete: boolean,
  runtimeDependent = false,
): MatchResult {
  if (!entry) return { hit: false, reason: "absent" };
  if (runtimeDependent) return { hit: false, reason: "target_missing" };
  if (entry.format !== CACHE_FORMAT)
    return { hit: false, reason: "format_mismatch" };
  if (entry.matcher !== MATCHER_VERSION)
    return { hit: false, reason: "matcher_mismatch" };
  if (!validEntry(entry)) return { hit: false, reason: "corrupt" };
  if (entry.pageKey !== pageKey(key, route, operation, sentence))
    return { hit: false, reason: "target_missing" };
  if (!complete) return { hit: false, reason: "candidate_set_incomplete" };
  const ranked = candidates
    .map((candidate) => ({ candidate, ...score(entry, candidate, key) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score === 0)
    return { hit: false, reason: "target_missing" };
  if (best.conflict) return { hit: false, reason: "strong_signal_conflict" };
  if (best.candidate.disabled) return { hit: false, reason: "not_actionable" };
  if (!best.identity || best.score < 8)
    return { hit: false, reason: "low_score" };
  if (ranked[1] && best.score - ranked[1].score < 2)
    return { hit: false, reason: "near_tie" };
  return { hit: true, candidate: best.candidate };
}
