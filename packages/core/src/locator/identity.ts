import { keyedDigest, type CacheEntry } from "../page-cache.js";
import type { Candidate } from "../page-protocol.js";

const controlIdentity = (candidate: Candidate): readonly unknown[] => [
  candidate.signals.nodeId,
  candidate.tag,
  candidate.role,
  candidate.name,
  candidate.inputType,
  candidate.editable,
  candidate.disabled,
  candidate.signals.rawName,
  candidate.signals.nameTruncated,
  candidate.signals.region,
  candidate.signals.path,
  candidate.signals.hook,
  candidate.signals.id,
  candidate.signals.name,
  candidate.signals.href,
];

const identity = (candidate: Candidate): readonly unknown[] => [
  ...controlIdentity(candidate),
  candidate.signals.item,
  candidate.signals.section,
  JSON.stringify(candidate.peers),
  candidate.location,
];

export function sameIdentity(a: Candidate, b: Candidate): boolean {
  const left = identity(a);
  const right = identity(b);
  return left.every((value, index) => value === right[index]);
}

export function sameChoiceSurface(
  original: readonly Candidate[],
  fresh: readonly Candidate[],
): boolean {
  return (
    original.length === fresh.length &&
    original.every((candidate, index) => {
      const next = fresh[index];
      return !!next && sameIdentity(candidate, next);
    })
  );
}

export function exactNameRequested(
  sentence: string,
  candidate: Candidate,
): boolean {
  if (candidate.signals.nameTruncated) return false;
  const words = (text: string) =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const name = words(candidate.name);
  const request = words(sentence);
  return (
    name.length > 0 &&
    request.some((_, index) =>
      name.every((word, offset) => request[index + offset] === word),
    )
  );
}

export function sameNodeControl(a: Candidate, b: Candidate): boolean {
  if (!a.signals.nodeId) return false;
  const left = controlIdentity(a);
  const right = controlIdentity(b);
  return left.every((value, index) => value === right[index]);
}

export function provedTargetChange(
  old: CacheEntry,
  selected: Candidate,
  candidates: readonly Candidate[],
  key: Uint8Array,
): boolean {
  const oldHook = old.digests.hook;
  const oldId = old.digests.id;
  const hook = selected.signals.hook;
  const id = selected.signals.id;
  const present = [oldHook, oldId, hook, id].every(Boolean);
  if (!present) return false;
  const unchanged = [
    oldHook === keyedDigest(key, hook!),
    oldId === keyedDigest(key, id!),
  ].some(Boolean);
  if (unchanged) return false;
  return candidates.some(
    (candidate) =>
      candidate.ref !== selected.ref &&
      matchesDigests(candidate, oldHook!, oldId!, key),
  );
}

function matchesDigests(
  candidate: Candidate,
  hook: string,
  id: string,
  key: Uint8Array,
): boolean {
  const values = [candidate.signals.hook, candidate.signals.id];
  if (!values.every(Boolean)) return false;
  return (
    keyedDigest(key, values[0]!) === hook && keyedDigest(key, values[1]!) === id
  );
}
