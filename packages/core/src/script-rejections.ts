import path from "node:path";
import type { FlowSource } from "./flow-types.js";
import { parseFrame, pathKey } from "./script-registry.js";

/**
 * Where a rejection that no code handled belongs. Test code can start work it
 * never awaits, such as `expect.poll` or an API call, and that work can reject
 * after its own test has finished, while another test runs.
 */
export type RejectionOwner =
  | { readonly kind: "attempt"; readonly index: number }
  | {
      readonly kind: "run";
      readonly reason: StrayReason;
      readonly source?: FlowSource;
      /** The test whose lines hold the frame, when exactly one does. */
      readonly test?: string;
    };

/**
 * Why no test could be blamed: its test had `finished`; the lines are
 * `shared` by several tests, as when tests are declared in a loop; project
 * code threw `outside` any test's lines; the stack has only Sedum or library
 * code (`internal`); or the value carries no stack (`unknown`).
 */
export type StrayReason =
  "finished" | "shared" | "outside" | "internal" | "unknown";

function insideProject(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/u).includes("node_modules")
  );
}

/** The lines a `test()` covers: its declaration up to the next test's. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
  /** The test's id, to name it when it leaves work behind. */
  readonly id?: string;
}

export interface RunningTest {
  readonly file: string;
  readonly lines: LineRange;
}

/**
 * Attribute a rejection by its stack, innermost frame first. A test is blamed
 * only when a frame lies inside its lines, and no other test's, while it
 * runs. A frame inside the lines of a test that is not running means that
 * test left work behind. Lines several tests share, as when tests are
 * declared in a loop, cannot tell them apart, so nobody is blamed.
 * Anything else, such as a helper at the top of a file, which any test could
 * have called, is reported for the run rather than blamed on whichever test
 * happens to be running. `known` is keyed by `pathKey(file)`. Pure, so the
 * policy is testable without a listener.
 */
export function attributeRejection(
  reason: unknown,
  running: readonly RunningTest[],
  known: ReadonlyMap<string, readonly LineRange[]>,
  projectRoot: string,
): RejectionOwner {
  const stack = reason instanceof Error ? reason.stack : undefined;
  const frames = (stack?.split("\n").slice(1) ?? []).flatMap((frame) => {
    const source = parseFrame(frame);
    return source ? [source] : [];
  });
  const root = pathKey(projectRoot);
  const project = frames.filter((frame) =>
    insideProject(pathKey(frame.file), root),
  );
  const inside = (line: number, lines: LineRange) =>
    line >= lines.start && line <= lines.end;
  for (const frame of project) {
    if (!frame.file.endsWith(".test.ts")) continue;
    const key = pathKey(frame.file);
    const holders = (known.get(key) ?? []).filter((lines) =>
      inside(frame.line, lines),
    );
    const owners = running.flatMap((test, index) =>
      pathKey(test.file) === key && inside(frame.line, test.lines)
        ? [index]
        : [],
    );
    if (holders.length > 1 || owners.length > 1)
      return { kind: "run", reason: "shared", source: frame };
    if (owners.length === 1) return { kind: "attempt", index: owners[0]! };
    if (holders.length === 1)
      return {
        kind: "run",
        reason: "finished",
        source: frame,
        ...(holders[0]!.id ? { test: holders[0]!.id } : {}),
      };
  }
  if (project[0]) return { kind: "run", reason: "outside", source: project[0] };
  return { kind: "run", reason: frames.length ? "internal" : "unknown" };
}

export interface UnattributedRejection {
  readonly reason: StrayReason;
  readonly message: string;
  readonly source?: FlowSource;
  readonly test?: string;
}

/** One line naming a rejection's value, for a report or the terminal. */
export function describeRejection(reason: unknown): string {
  const text =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === "string"
        ? reason
        : "a non-Error value";
  return (text.split("\n")[0] ?? text).slice(0, 300);
}

/**
 * One `unhandledRejection` listener for a whole run. Attempts register while
 * they run; a rejection is handed to the attempt that owns it or kept for the
 * run to report, so a stray promise never kills the process or blames an
 * unrelated test.
 */
export class RejectionRouter {
  readonly #attempts = new Map<
    symbol,
    RunningTest & { readonly receive: (reason: unknown) => void }
  >();
  /** Every test's lines seen this run, by file, kept after it finishes. */
  readonly #known = new Map<string, readonly LineRange[]>();
  readonly #unattributed: UnattributedRejection[] = [];
  #installed = false;
  static #routing = 0;

  constructor(private readonly projectRoot: string) {}

  /**
   * Whether any router is listening. A process-wide fallback for rejections
   * that arrive after a run (the `sedum` binary installs one) stands aside
   * while a router owns them.
   */
  static get routing(): boolean {
    return RejectionRouter.#routing > 0;
  }

  /** Rejections no running test could own, in arrival order. */
  get unattributed(): readonly UnattributedRejection[] {
    return this.#unattributed;
  }

  readonly #handle = (reason: unknown): void => {
    const attempts = [...this.#attempts.values()];
    const owner = attributeRejection(
      reason,
      attempts,
      this.#known,
      this.projectRoot,
    );
    if (owner.kind === "attempt") {
      attempts[owner.index]!.receive(reason);
      return;
    }
    this.#unattributed.push({
      reason: owner.reason,
      message: describeRejection(reason),
      ...(owner.source ? { source: owner.source } : {}),
      ...(owner.test ? { test: owner.test } : {}),
    });
  };

  install(): void {
    if (this.#installed) return;
    process.on("unhandledRejection", this.#handle);
    this.#installed = true;
    RejectionRouter.#routing++;
  }

  dispose(): void {
    if (!this.#installed) return;
    process.off("unhandledRejection", this.#handle);
    this.#installed = false;
    RejectionRouter.#routing--;
  }

  /**
   * Route rejections from one running test to `receive` until released.
   * `lines` is that test's range; `fileTests` are all of its file's tests.
   */
  register(
    test: RunningTest,
    fileTests: readonly LineRange[],
    receive: (reason: unknown) => void,
  ): () => void {
    this.#known.set(pathKey(test.file), fileTests);
    const key = Symbol(test.file);
    this.#attempts.set(key, { ...test, receive });
    return () => {
      this.#attempts.delete(key);
    };
  }
}
