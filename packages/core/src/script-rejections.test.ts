import path from "node:path";
import { afterEach, describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  attributeRejection,
  RejectionRouter,
  type LineRange,
} from "./script-rejections.js";
import { pathKey } from "./script-registry.js";

const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 500,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const root = path.resolve("/project");
const shop = path.join(root, "tests", "shop.test.ts");
const cart = path.join(root, "tests", "cart.test.ts");
const helper = path.join(root, "tests", "support", "api.ts");
const library = path.join(root, "node_modules", "lib", "index.js");

function failure(...frames: string[]): Error {
  const error = new Error("boom");
  error.stack = [
    "Error: boom",
    ...frames.map((frame) => `    at fn (${frame})`),
  ].join("\n");
  return error;
}

const first: LineRange = { start: 3, end: 9 };
const second: LineRange = { start: 10, end: 20 };
const known = new Map([[pathKey(shop), [first, second]]]);

describe("attributing a rejection nothing handled", () => {
  it("blames the running test whose lines hold a frame", () => {
    expect(
      attributeRejection(
        failure(`${library}:1:1`, `${shop}:12:5`),
        [
          { file: cart, lines: { start: 1, end: 50 } },
          { file: shop, lines: second },
        ],
        known,
        root,
      ),
    ).toEqual({ kind: "attempt", index: 1 });
  });

  it("reports work a finished test left behind, not the running one", () => {
    expect(
      attributeRejection(
        failure(`${shop}:5:3`),
        [{ file: shop, lines: second }],
        known,
        root,
      ),
    ).toEqual({
      kind: "run",
      reason: "finished",
      source: { file: shop, line: 5, col: 3 },
    });
  });

  it("does not guess for helper code any test could have called", () => {
    for (const frame of [`${shop}:1:1`, `${helper}:4:2`])
      expect(
        attributeRejection(
          failure(frame),
          [{ file: shop, lines: second }],
          known,
          root,
        ),
      ).toMatchObject({ kind: "run", reason: "outside" });
  });

  it("calls a stack without project code internal, and a bare value unknown", () => {
    const running = [{ file: shop, lines: second }];
    expect(
      attributeRejection(failure(`${library}:1:1`), running, known, root),
    ).toEqual({ kind: "run", reason: "internal" });
    expect(attributeRejection("nope", running, known, root)).toEqual({
      kind: "run",
      reason: "unknown",
    });
  });

  propertyTest("only a test whose lines hold a frame is ever blamed", () => {
    hegel.test((tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const starts = [
        ...new Set(
          tc.draw(
            gs.arrays(gs.integers({ minValue: 1, maxValue: 200 }), {
              minSize: count,
              maxSize: count,
            }),
          ),
        ),
      ].sort((a, b) => a - b);
      const ranges = starts.map((start, index) => ({
        start,
        end: (starts[index + 1] ?? 10_000) - 1,
      }));
      const runningIndexes = ranges
        .map((_, index) => index)
        .filter(() => tc.draw(gs.booleans()));
      const running = runningIndexes.map((index) => ({
        file: shop,
        lines: ranges[index]!,
      }));
      const lines = tc.draw(
        gs.arrays(gs.integers({ minValue: 1, maxValue: 400 }), { maxSize: 4 }),
      );
      const owner = attributeRejection(
        failure(...lines.map((line) => `${shop}:${line}:1`)),
        running,
        new Map([[pathKey(shop), ranges]]),
        root,
      );
      if (owner.kind === "attempt") {
        const blamed = running[owner.index]!.lines;
        expect(
          lines.some((line) => line >= blamed.start && line <= blamed.end),
        ).toBe(true);
      }
    }, propertySettings);
  });
});

describe("the run's rejection router", () => {
  let router: RejectionRouter | undefined;
  afterEach(() => router?.dispose());

  it("routes to the owning test and keeps strays for the run", () => {
    router = new RejectionRouter(root);
    router.install();
    expect(RejectionRouter.routing).toBe(true);
    const received: unknown[] = [];
    const release = router.register(
      { file: shop, lines: second },
      [first, second],
      (reason) => received.push(reason),
    );
    const owned = failure(`${shop}:11:1`);
    const stray = failure(`${shop}:4:1`);
    process.emit("unhandledRejection", owned, Promise.resolve());
    process.emit("unhandledRejection", stray, Promise.resolve());
    release();
    expect(received).toEqual([owned]);
    expect(router.unattributed).toEqual([
      {
        reason: "finished",
        message: "Error: boom",
        source: { file: shop, line: 4, col: 1 },
      },
    ]);
  });

  it("removes its listener when disposed, so repeated runs do not leak", () => {
    const before = process.listenerCount("unhandledRejection");
    for (let run = 0; run < 20; run++) {
      const each = new RejectionRouter(root);
      each.install();
      each.dispose();
    }
    expect(process.listenerCount("unhandledRejection")).toBe(before);
    expect(RejectionRouter.routing).toBe(false);
  });
});
