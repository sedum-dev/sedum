/** Serializable values extracted from a Playwright ARIA snapshot. */
export type ObservationOperation = "click" | "fill" | "read";

export interface CandidateSignal {
  readonly hook?: string;
  readonly id?: string;
  readonly inputType?: string;
  readonly href?: string;
  readonly path: string;
}

export interface ObservedCandidate {
  readonly id: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly peers: readonly string[];
  readonly editable: boolean;
  readonly disabled: boolean;
  /** Transient local cache evidence. Never include this in a provider request. */
  readonly signals: CandidateSignal;
}

export interface ObservationVersion {
  readonly document: number;
  readonly route: string;
  readonly signature: string;
}

export interface PageObservation {
  readonly complete: boolean;
  readonly reason?:
    | "snapshot_invalid"
    | "resource_ceiling"
    | "candidate_set_incomplete"
    | "digest_incomplete"
    | "mapping_ambiguous"
    | "scope_ambiguous"
    | "not_quiet";
  readonly version?: ObservationVersion;
  readonly candidates: readonly ObservedCandidate[];
  readonly digest?: string;
}

export interface ResolverCandidate {
  readonly id: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly peers: readonly string[];
  readonly editable: boolean;
  readonly disabled: boolean;
}

export const PROVIDER_PAGE_LIMIT = 128;
export const MAX_CANDIDATES = 2048;
export const MAX_SNAPSHOT_NODES = 20_000;
export const MAX_SNAPSHOT_BYTES = 1_048_576;
export const MAX_NAME_POINTS = 120;
export const MAX_PEER_POINTS = 80;
export const MAX_DIGEST_POINTS = 4096;

const CLICK_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
]);
const FILL_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const READ_ROLES = new Set(["heading", "paragraph"]);
const ITEM_ROLES = new Set(["article", "listitem", "row", "group"]);
const EDITABLE_ROLES = new Set([...FILL_ROLES, "slider"]);

export interface SnapshotNode {
  readonly role: string;
  readonly name?: string;
  readonly text?: string;
  readonly disabled?: boolean;
  readonly children: readonly (SnapshotNode | string)[];
}

export interface CandidateSpec {
  readonly role: string;
  readonly name: string;
  readonly peers: readonly string[];
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly itemRole?: string;
  readonly itemHeading?: string;
  readonly itemText?: string;
  readonly fallbackPeer?: string;
}

export function codePoints(value: string): number {
  return Array.from(value).length;
}

function normalized(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function parseNode(value: unknown, count: { value: number }): SnapshotNode {
  if (++count.value > MAX_SNAPSHOT_NODES) throw new Error("resource_ceiling");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("snapshot_invalid");
  const item = value as Record<string, unknown>;
  if (typeof item.role !== "string" || !item.role)
    throw new Error("snapshot_invalid");
  if (item.name !== undefined && typeof item.name !== "string")
    throw new Error("snapshot_invalid");
  if (item.text !== undefined && typeof item.text !== "string")
    throw new Error("snapshot_invalid");
  if (item.disabled !== undefined && typeof item.disabled !== "boolean")
    throw new Error("snapshot_invalid");
  if (item.children !== undefined && !Array.isArray(item.children))
    throw new Error("snapshot_invalid");
  const children = (item.children ?? []) as unknown[];
  return {
    role: item.role,
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.text === "string" ? { text: item.text } : {}),
    ...(typeof item.disabled === "boolean" ? { disabled: item.disabled } : {}),
    children: children.map((child) =>
      typeof child === "string" ? child : parseNode(child, count),
    ),
  };
}

export function parseSnapshot(raw: unknown): readonly SnapshotNode[] {
  if (!Array.isArray(raw)) throw new Error("snapshot_invalid");
  const count = { value: 0 };
  return raw.map((node: unknown) => parseNode(node, count));
}

function textParts(node: SnapshotNode, result: string[]): void {
  if (EDITABLE_ROLES.has(node.role)) return;
  if (node.text) result.push(node.text);
  for (const child of node.children) {
    if (typeof child === "string") result.push(child);
    else textParts(child, result);
  }
}

function itemPeers(
  item: SnapshotNode | undefined,
  candidate: SnapshotNode,
): string[] {
  if (!item) return [];
  const peers: string[] = [];
  const add = (value: string): void => {
    const text = normalized(value);
    if (!text || peers.includes(text)) return;
    peers.push(text);
    if (peers.length > 32) throw new Error("resource_ceiling");
  };
  const walk = (node: SnapshotNode): void => {
    if (node === candidate || EDITABLE_ROLES.has(node.role)) return;
    if (node.role === "heading" && node.name) {
      add(node.name);
    } else if (node.text && node.role !== "button" && node.role !== "link") {
      add(node.text);
    }
    for (const child of node.children) {
      if (typeof child !== "string") walk(child);
      else if (node.role !== "button" && node.role !== "link") add(child);
    }
  };
  walk(item);
  return peers
    .sort((a, b) => Number(isWeakPeer(a)) - Number(isWeakPeer(b)))
    .slice(0, 2);
}

function isWeakPeer(peer: string): boolean {
  return /^[\p{Sc}\d.,\s%+-]+$/u.test(peer);
}

function meaningfulItemText(peers: readonly string[]): string | undefined {
  return peers.find((peer) => !isWeakPeer(peer));
}

function itemHeading(item: SnapshotNode | undefined): string | undefined {
  if (!item) return undefined;
  const queue = [item];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (node.role === "heading" && node.name) return normalized(node.name);
    for (const child of node.children)
      if (typeof child !== "string") queue.push(child);
  }
  return undefined;
}

export function projectSnapshot(
  roots: readonly SnapshotNode[],
  operation: ObservationOperation,
): readonly CandidateSpec[] {
  const roles =
    operation === "click"
      ? CLICK_ROLES
      : operation === "fill"
        ? FILL_ROLES
        : READ_ROLES;
  const candidates: CandidateSpec[] = [];
  const visit = (
    node: SnapshotNode,
    item?: SnapshotNode,
    precedingText?: string,
  ): void => {
    const currentItem = ITEM_ROLES.has(node.role) ? node : item;
    if (roles.has(node.role)) {
      const name = normalized(
        node.name ?? (operation === "read" ? (node.text ?? "") : ""),
      );
      if (!name && operation !== "read") throw new Error("snapshot_invalid");
      if (name) {
        if (codePoints(name) > MAX_NAME_POINTS)
          throw new Error("candidate_field_too_large");
        const fallbackPeer =
          !currentItem &&
          precedingText &&
          codePoints(precedingText) <= MAX_PEER_POINTS
            ? precedingText
            : undefined;
        const peers = currentItem
          ? itemPeers(currentItem, node)
          : fallbackPeer
            ? [fallbackPeer]
            : [];
        if (peers.some((peer) => codePoints(peer) > MAX_PEER_POINTS))
          throw new Error("candidate_field_too_large");
        const heading = itemHeading(currentItem);
        const itemText = heading ? undefined : meaningfulItemText(peers);
        candidates.push({
          role: node.role,
          name,
          peers,
          disabled: node.disabled ?? false,
          editable: EDITABLE_ROLES.has(node.role),
          ...(currentItem ? { itemRole: currentItem.role } : {}),
          ...(heading ? { itemHeading: heading } : {}),
          ...(itemText ? { itemText } : {}),
          ...(fallbackPeer ? { fallbackPeer } : {}),
        });
        if (candidates.length > MAX_CANDIDATES)
          throw new Error("candidate_set_incomplete");
      }
    }
    let recent = precedingText;
    for (const child of node.children) {
      if (typeof child === "string") {
        const text = normalized(child);
        if (text && !isWeakPeer(text)) recent = text;
      } else {
        visit(child, currentItem, recent);
        if (!EDITABLE_ROLES.has(child.role) && !CLICK_ROLES.has(child.role)) {
          const text = normalized(
            child.role === "heading" ? (child.name ?? "") : (child.text ?? ""),
          );
          if (text && !isWeakPeer(text)) recent = text;
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return candidates;
}

/** Build the exact allowlist that may cross the Resolver boundary. */
export function resolverPage(
  observation: PageObservation,
  offset = 0,
): {
  readonly candidates: readonly ResolverCandidate[];
  readonly next: number | null;
} {
  if (
    !observation.complete ||
    !observation.version ||
    observation.digest === undefined
  )
    throw new Error("observation_incomplete");
  const candidates = observation.candidates;
  if (
    candidates.length > MAX_CANDIDATES ||
    candidates.some(
      (item) =>
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.tag !== "string" ||
        !item.tag ||
        typeof item.role !== "string" ||
        !item.role ||
        typeof item.name !== "string" ||
        !item.name ||
        codePoints(item.name) > MAX_NAME_POINTS ||
        !Array.isArray(item.peers) ||
        item.peers.length > 2 ||
        item.peers.some(
          (peer) =>
            typeof peer !== "string" || codePoints(peer) > MAX_PEER_POINTS,
        ) ||
        typeof item.editable !== "boolean" ||
        typeof item.disabled !== "boolean",
    )
  )
    throw new Error("candidate_set_incomplete");
  if (!Number.isInteger(offset) || offset < 0 || offset > candidates.length)
    throw new RangeError("Invalid candidate page offset");
  const page = candidates
    .slice(offset, offset + PROVIDER_PAGE_LIMIT)
    .map((item) => ({
      id: item.id,
      tag: item.tag,
      role: item.role,
      name: item.name,
      peers: [...item.peers],
      editable: item.editable,
      disabled: item.disabled,
    }));
  return {
    candidates: page,
    next:
      offset + page.length < candidates.length ? offset + page.length : null,
  };
}

/** The Judge receives only this validated visible, non-editable text. */
export function judgeText(observation: PageObservation): string {
  if (
    !observation.complete ||
    !observation.version ||
    typeof observation.digest !== "string" ||
    codePoints(observation.digest) > MAX_DIGEST_POINTS
  )
    throw new Error("observation_incomplete");
  return observation.digest;
}

export function snapshotText(roots: readonly SnapshotNode[]): string {
  const parts: string[] = [];
  for (const root of roots) textParts(root, parts);
  return normalized(parts.join(" "));
}
