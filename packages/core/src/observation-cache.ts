import { createHmac, timingSafeEqual } from "node:crypto";
import {
  MAX_CANDIDATES,
  MAX_DIGEST_POINTS,
  MAX_NAME_POINTS,
  MAX_PEER_POINTS,
  codePoints,
} from "./snapshot-observation.js";
import type {
  ObservationOperation,
  ObservedCandidate,
  PageObservation,
} from "./snapshot-observation.js";

export const CACHE_FORMAT_VERSION = 1;
export const CACHE_MATCHER_VERSION = 1;

export interface KeyedSignals {
  readonly hook?: string;
  readonly id?: string;
  readonly name?: string;
  readonly href?: string;
  readonly peers: readonly string[];
}

export interface ObservationCacheEntry {
  readonly formatVersion: number;
  readonly matcherVersion: number;
  readonly key: string;
  readonly tag: string;
  readonly role: string;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly inputType?: string;
  readonly path: string;
  readonly signals: KeyedSignals;
}

export type CacheMatchResult =
  | { readonly hit: true; readonly id: string }
  | {
      readonly hit: false;
      readonly reason:
        | "storage_miss"
        | "runtime_dependent"
        | "version_incompatible"
        | "malformed_entry"
        | "key_mismatch"
        | "candidate_set_incomplete"
        | "target_missing"
        | "strong_signal_conflict"
        | "low_score"
        | "near_tie"
        | "not_actionable";
    };

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function digest(key: Uint8Array, value: string): string {
  if (key.byteLength !== 32)
    throw new RangeError("Cache HMAC key must be 256 bits");
  return createHmac("sha256", key).update(normalize(value)).digest("hex");
}

function sameDigest(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || !/^[0-9a-f]{64}$/u.test(a) || !/^[0-9a-f]{64}$/u.test(b))
    return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function cacheKey(
  key: Uint8Array,
  route: string,
  operation: ObservationOperation,
  sentence: string,
): string {
  const parsed = new URL(route);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Unsupported cache route");
  return digest(
    key,
    JSON.stringify([
      parsed.origin,
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
      operation,
      normalize(sentence),
    ]),
  );
}

function keyedSignals(
  key: Uint8Array,
  candidate: ObservedCandidate,
): KeyedSignals {
  return {
    ...(candidate.signals.hook
      ? { hook: digest(key, candidate.signals.hook) }
      : {}),
    ...(candidate.signals.id ? { id: digest(key, candidate.signals.id) } : {}),
    name: digest(key, candidate.name),
    ...(candidate.signals.href
      ? { href: digest(key, candidate.signals.href) }
      : {}),
    peers: candidate.peers.map((peer) => digest(key, peer)),
  };
}

function semanticIdentity(signals: KeyedSignals): string {
  return JSON.stringify([
    signals.hook,
    signals.id,
    signals.name,
    signals.href,
    signals.peers,
  ]);
}

function validEntry(value: unknown): value is ObservationCacheEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.key !== "string" ||
    !/^[0-9a-f]{64}$/u.test(item.key) ||
    typeof item.tag !== "string" ||
    !item.tag ||
    item.tag.length > 40 ||
    typeof item.role !== "string" ||
    !item.role ||
    item.role.length > 40 ||
    typeof item.editable !== "boolean" ||
    typeof item.disabled !== "boolean" ||
    typeof item.path !== "string" ||
    item.path.length > 512 ||
    (item.inputType !== undefined &&
      (typeof item.inputType !== "string" || item.inputType.length > 40)) ||
    !item.signals ||
    typeof item.signals !== "object"
  )
    return false;
  const signals = item.signals as Record<string, unknown>;
  const validDigest = (digest: unknown): boolean =>
    digest === undefined ||
    (typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest));
  return (
    validDigest(signals.hook) &&
    validDigest(signals.id) &&
    typeof signals.name === "string" &&
    validDigest(signals.name) &&
    validDigest(signals.href) &&
    Array.isArray(signals.peers) &&
    signals.peers.length <= 2 &&
    signals.peers.every(
      (peer: unknown) => typeof peer === "string" && validDigest(peer),
    )
  );
}

function validCandidate(candidate: ObservedCandidate): boolean {
  const signals = candidate?.signals;
  return (
    typeof candidate?.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.tag === "string" &&
    candidate.tag.length > 0 &&
    typeof candidate.role === "string" &&
    candidate.role.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    codePoints(candidate.name) <= MAX_NAME_POINTS &&
    Array.isArray(candidate.peers) &&
    candidate.peers.length <= 2 &&
    candidate.peers.every(
      (peer) => typeof peer === "string" && codePoints(peer) <= MAX_PEER_POINTS,
    ) &&
    typeof candidate.editable === "boolean" &&
    typeof candidate.disabled === "boolean" &&
    !!signals &&
    typeof signals.path === "string" &&
    signals.path.length <= 512 &&
    [signals.hook, signals.id, signals.href, signals.inputType].every(
      (value) =>
        value === undefined ||
        (typeof value === "string" && value.length <= 512),
    )
  );
}

function validObservation(
  observation: PageObservation,
): observation is PageObservation & {
  readonly version: NonNullable<PageObservation["version"]>;
  readonly digest: string;
} {
  return (
    observation.complete &&
    !!observation.version &&
    typeof observation.version.route === "string" &&
    typeof observation.digest === "string" &&
    codePoints(observation.digest) <= MAX_DIGEST_POINTS &&
    Array.isArray(observation.candidates) &&
    observation.candidates.length <= MAX_CANDIDATES &&
    observation.candidates.every(validCandidate)
  );
}

/** Stage only after a successful action and only if current semantics distinguish the target. */
export function stageCacheEntry(
  observation: PageObservation,
  selectedId: string,
  key: Uint8Array,
  operation: ObservationOperation,
  sentence: string,
  actionSucceeded: boolean,
  runtimeDependent = false,
): ObservationCacheEntry | undefined {
  if (
    !actionSucceeded ||
    !validObservation(observation) ||
    runtimeDependent ||
    !/^https?:\/\//u.test(observation.version.route)
  )
    return undefined;
  const selected = observation.candidates.find(
    (candidate) => candidate.id === selectedId,
  );
  if (!selected || selected.disabled) return undefined;
  const signals = keyedSignals(key, selected);
  if (
    observation.candidates.some(
      (candidate) =>
        candidate.id !== selectedId &&
        semanticIdentity(keyedSignals(key, candidate)) ===
          semanticIdentity(signals),
    )
  )
    return undefined;
  return {
    formatVersion: CACHE_FORMAT_VERSION,
    matcherVersion: CACHE_MATCHER_VERSION,
    key: cacheKey(key, observation.version.route, operation, sentence),
    tag: selected.tag,
    role: selected.role,
    editable: selected.editable,
    disabled: selected.disabled,
    ...(selected.signals.inputType
      ? { inputType: selected.signals.inputType }
      : {}),
    path: selected.signals.path,
    signals,
  };
}

function score(
  entry: ObservationCacheEntry,
  current: ObservedCandidate,
  key: Uint8Array,
): number | "conflict" {
  if (
    entry.tag !== current.tag ||
    entry.role !== current.role ||
    entry.editable !== current.editable ||
    entry.disabled !== current.disabled ||
    (entry.inputType ?? "") !== (current.signals.inputType ?? "")
  )
    return "conflict";
  const live = keyedSignals(key, current);
  const strong: readonly [string | undefined, string | undefined, number][] = [
    [entry.signals.hook, live.hook, 8],
    [entry.signals.id, live.id, 8],
    [entry.signals.name, live.name, 5],
    [entry.signals.href, live.href, 5],
  ];
  let total = 0;
  for (const [stored, observed, points] of strong) {
    if (!stored) continue;
    if (!sameDigest(stored, observed)) return "conflict";
    total += points;
  }
  if (entry.signals.peers.length !== live.peers.length) return "conflict";
  for (let index = 0; index < entry.signals.peers.length; index++) {
    if (!sameDigest(entry.signals.peers[index], live.peers[index]))
      return "conflict";
    total += 4;
  }
  if (entry.path === current.signals.path) total++;
  return total;
}

export function matchCacheEntry(
  entry: unknown,
  observation: PageObservation,
  key: Uint8Array,
  operation: ObservationOperation,
  sentence: string,
  runtimeDependent = false,
): CacheMatchResult {
  if (runtimeDependent) return { hit: false, reason: "runtime_dependent" };
  if (!entry) return { hit: false, reason: "storage_miss" };
  if (!validEntry(entry)) return { hit: false, reason: "malformed_entry" };
  if (
    entry.formatVersion !== CACHE_FORMAT_VERSION ||
    entry.matcherVersion !== CACHE_MATCHER_VERSION
  )
    return { hit: false, reason: "version_incompatible" };
  if (!validObservation(observation))
    return { hit: false, reason: "candidate_set_incomplete" };
  if (!/^https?:\/\//u.test(observation.version.route))
    return { hit: false, reason: "key_mismatch" };
  if (
    !sameDigest(
      entry.key,
      cacheKey(key, observation.version.route, operation, sentence),
    )
  )
    return { hit: false, reason: "key_mismatch" };
  let winner: { id: string; score: number } | undefined;
  let runnerUp = -1;
  let conflict = false;
  for (const candidate of observation.candidates) {
    const currentScore = score(entry, candidate, key);
    if (currentScore === "conflict") {
      conflict = true;
      continue;
    }
    if (currentScore > (winner?.score ?? -1)) {
      runnerUp = winner?.score ?? runnerUp;
      winner = { id: candidate.id, score: currentScore };
    } else if (currentScore > runnerUp) runnerUp = currentScore;
  }
  if (!winner)
    return {
      hit: false,
      reason: conflict ? "strong_signal_conflict" : "target_missing",
    };
  if (winner.score < 8) return { hit: false, reason: "low_score" };
  if (winner.score - runnerUp < 2) return { hit: false, reason: "near_tie" };
  const selected = observation.candidates.find(
    (candidate) => candidate.id === winner.id,
  )!;
  if (selected.disabled) return { hit: false, reason: "not_actionable" };
  const winnerIdentity = semanticIdentity(keyedSignals(key, selected));
  if (
    observation.candidates.some(
      (candidate) =>
        candidate.id !== selected.id &&
        semanticIdentity(keyedSignals(key, candidate)) === winnerIdentity,
    )
  )
    return { hit: false, reason: "near_tie" };
  return { hit: true, id: winner.id };
}
