export const PAGE_PROTOCOL = 1;
export const CANDIDATE_LIMIT = 128;
export const NAME_LIMIT = 120;
export const PEER_LIMIT = 80;
export const DIGEST_LIMIT = 4096;
const SAFE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
  "heading",
]);
export function isSafeRole(value: string): boolean {
  return SAFE_ROLES.has(value);
}
export function isWeakPeer(value: string): boolean {
  const text = value.trim();
  return (
    /^[\p{Sc}\d.,\s%+-]+$/u.test(text) ||
    /^(USD|EUR|GBP|JPY|CAD|AUD|CHF)$/i.test(text)
  );
}

export type Operation = "click" | "fill" | "read";
export interface PageVersion {
  readonly document: string;
  readonly revision: number;
  readonly route: string;
}
export interface Candidate {
  readonly ref: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly peers: readonly string[];
  /** Landmark and nearest heading, e.g. "footer · Company". Sent to the model. */
  readonly location?: string;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly inputType: string;
  readonly signals: {
    readonly hook?: string;
    readonly id?: string;
    readonly name?: string;
    readonly href?: string;
    /** Local disambiguation hint. Never part of the provider projection. */
    readonly region?: "article-body";
    readonly path: string;
    /** True only when the first peer contains the entire non-interactive item context. */
    readonly contextComplete?: boolean;
    /** Local signal: the model sees only a visibly shortened accessible name. */
    readonly nameTruncated?: boolean;
    /** Full name for same-target checks; never included in provider projection. */
    readonly rawName?: string;
    /** Stable document-local element identity; never included in provider projection. */
    readonly nodeId?: string;
  };
}
export interface CandidatePage {
  readonly protocol: number;
  readonly version: PageVersion;
  readonly total: number;
  readonly offset: number;
  readonly next: number | null;
  readonly complete: boolean;
  readonly candidates: readonly Candidate[];
}
export interface DigestResult {
  readonly protocol: number;
  readonly version: PageVersion;
  readonly text: string;
  readonly complete: boolean;
  readonly error?: "digest_too_large" | "resource_ceiling" | "scope_ambiguous";
}
export interface Aim {
  readonly ref: string;
  readonly document: string;
  readonly route: string;
  readonly revision: number;
  readonly tag: string;
  readonly name: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}
/** A fill target is tied to the exact element in a collected fill snapshot. */
export interface FillTarget {
  readonly ref: string;
  readonly version: PageVersion;
  readonly tag: string;
  readonly name: string;
}
export type ReadTargetResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "stale" | "empty" | "too_long" };
export type AimResult =
  | { readonly actionable: true; readonly aim: Aim }
  | {
      readonly actionable: false;
      readonly reason: "action_started";
      readonly retryable: false;
      readonly callLog?: readonly string[];
    }
  | {
      readonly actionable: false;
      readonly reason: "stale" | "target_missing" | "not_actionable";
    };
export interface PageBridge {
  readonly protocol: number;
  collect(input: {
    operation: Operation;
    offset?: number;
    version?: PageVersion;
  }): CandidatePage;
  digest(): DigestResult;
  pageVersion(): PageVersion;
  quiet(input: {
    ms: number;
    timeoutMs: number;
  }): Promise<{ version: PageVersion; quiet: boolean }>;
  findBySignals(input: { operation: Operation }): CandidatePage;
  clickTarget(ref: string): AimResult;
  checkAim(aim: Aim): AimResult;
  fillElement(target: FillTarget): Element | null;
  readTarget(target: FillTarget): ReadTargetResult;
  clearRefs(): void;
}
declare global {
  interface Window {
    __sedum?: PageBridge;
  }
}

export function codePoints(text: string): number {
  return Array.from(text).length;
}

export function projectCandidates(page: CandidatePage): readonly {
  id: string;
  tag: string;
  role: string;
  name: string;
  peers: readonly string[];
  location?: string;
  editable: boolean;
  disabled: boolean;
}[] {
  if (!page.complete || page.candidates.length > CANDIDATE_LIMIT)
    throw new Error("candidate_set_incomplete");
  return page.candidates.map((candidate) => {
    if (
      codePoints(candidate.name) > NAME_LIMIT ||
      (candidate.role !== "" && !isSafeRole(candidate.role)) ||
      candidate.peers.length > 2 ||
      candidate.peers.some((peer) => codePoints(peer) > PEER_LIMIT) ||
      (candidate.location !== undefined &&
        codePoints(candidate.location) > PEER_LIMIT)
    )
      throw new Error("candidate_field_too_large");
    return {
      id: candidate.ref,
      tag: candidate.tag,
      role: candidate.role,
      name: candidate.name,
      peers: candidate.peers,
      ...(candidate.location ? { location: candidate.location } : {}),
      editable: candidate.editable,
      disabled: candidate.disabled,
    };
  });
}

export function projectDigest(result: DigestResult): string {
  if (
    !result.complete ||
    result.error ||
    codePoints(result.text) > DIGEST_LIMIT
  )
    throw new Error(result.error ?? "digest_incomplete");
  return result.text;
}
