import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "./browser-driver.js";
import { resolveTarget } from "./locator.js";
import { NoopCacheStore, type CacheStore } from "./cache-store.js";
import { pageKey, stageEntry } from "./page-cache.js";
import type { Candidate, CandidatePage, PageVersion } from "./page-protocol.js";
import type {
  ProviderCall,
  Resolver,
  ResolverCandidates,
  ResolverDecision,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import {
  captureVisionObservation,
  VisionRequestError,
  type VisionResolver,
} from "./vision.js";

vi.mock("./vision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vision.js")>()),
  captureVisionObservation: vi.fn(),
}));

const call: ProviderCall = {
  requestedModel: "recorded",
  model: "recorded",
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 2 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};
const initial: PageVersion = {
  document: "doc",
  route: "https://fixture.test/",
  revision: 1,
};
const candidate = (
  index: number,
  overrides: Partial<Candidate> = {},
): Candidate => ({
  ref: `r${index}`,
  tag: "button",
  role: "button",
  name: `Item ${index}`,
  peers: [],
  editable: false,
  disabled: false,
  inputType: "",
  signals: { path: `body/button:${index}` },
  ...overrides,
});

function recordedPage(
  items: Candidate[],
  config: {
    fill?: Candidate[];
    corrupt?: (page: CandidatePage) => CandidatePage;
    onLive?: () => void;
    live?: () => Candidate[];
  } = {},
) {
  let current: PageVersion = initial;
  const setVersion = (version: PageVersion) => {
    current = version;
  };
  const evaluate = vi.fn(async (expression: string) => {
    const method = expression.match(/bridge\["([^"]+)"\]/)?.[1];
    const argument = JSON.parse(
      expression.match(/\)\((.*)\)$/s)?.[1] ?? "null",
    ) as {
      operation?: string;
      offset?: number;
      version?: PageVersion;
    } | null;
    let value: unknown;
    if (method === "pageVersion") value = current;
    else if (method === "collect") {
      const source =
        argument?.operation === "fill" ? (config.fill ?? items) : items;
      const offset = argument?.offset ?? 0;
      value = config.corrupt?.({
        protocol: 1,
        version: current,
        total: source.length,
        offset,
        next: offset + 128 < source.length ? offset + 128 : null,
        complete: true,
        candidates: source.slice(offset, offset + 128),
      }) ?? {
        protocol: 1,
        version: current,
        total: source.length,
        offset,
        next: offset + 128 < source.length ? offset + 128 : null,
        complete: true,
        candidates: source.slice(offset, offset + 128),
      };
    } else if (method === "findBySignals") {
      config.onLive?.();
      const source = config.live?.() ?? items;
      value = {
        protocol: 1,
        version: current,
        total: source.length,
        offset: 0,
        next: null,
        complete: true,
        candidates: source.map((item) => ({
          ...item,
          ref: `fresh-${item.ref}`,
        })),
      };
    } else throw new Error(`Unexpected ${method}`);
    return { installed: true, protocol: 1, value };
  });
  return { page: { evaluate } as unknown as BrowserPage, evaluate, setVersion };
}

function answer(
  options: ResolverCandidates,
  selected: string,
  weights?: Record<string, number>,
  confidence: number | null = null,
): ResolverDecision {
  const ids = options.options.map((option) =>
    option.kind === "none" ? "none" : option.candidate.id,
  );
  const probabilities =
    weights ??
    Object.fromEntries(
      ids.map((id) => [id, id === selected ? 0.8 : 0.2 / (ids.length - 1)]),
    );
  return {
    selection:
      selected === "none"
        ? { kind: "none" }
        : { kind: "candidate", id: selected },
    probabilities,
    confidence,
    call,
  };
}
function resolver(
  choose: (
    candidates: ResolverCandidates,
  ) => ResolverDecision | Promise<ResolverDecision>,
): Resolver {
  return { choose: vi.fn(async (_sentence, candidates) => choose(candidates)) };
}

describe("locator", () => {
  it("accepts a uniquely named same-node target after unrelated page churn", async () => {
    const target = candidate(1, {
      name: "Go to file",
      peers: ["Branches"],
      signals: { path: "main/input:0", nodeId: "node-1" },
    });
    const other = candidate(2, {
      name: "Old activity",
      signals: { path: "main/button:1", nodeId: "node-2" },
    });
    const recorded = recordedPage([target, other], {
      live: () => [
        { ...target, peers: ["Code"] },
        { ...other, name: "New activity" },
      ],
    });
    const model = resolver((options) => {
      recorded.setVersion({ ...initial, revision: 2 });
      return answer(options, target.ref);
    });
    const result = await resolveTarget(recorded.page, model, {
      operation: "click",
      sentence: "click the Go to file control",
    });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe(`fresh-${target.ref}`);
  });

  it("rejects a same-name competitor or replacement node after a model choice", async () => {
    const target = candidate(1, {
      name: "Go to file",
      signals: { path: "main/input:0", nodeId: "node-1" },
    });
    for (const live of [
      [
        target,
        candidate(2, {
          name: "Go to file",
          signals: { path: "main/input:1", nodeId: "node-2" },
        }),
      ],
      [
        {
          ...target,
          signals: { ...target.signals, nodeId: "replacement-node" },
        },
      ],
    ]) {
      const recorded = recordedPage([target], { live: () => live });
      const model = resolver((options) => {
        recorded.setVersion({ ...initial, revision: 2 });
        return answer(options, target.ref);
      });
      expect(
        await resolveTarget(recorded.page, model, {
          operation: "click",
          sentence: "click the Go to file control",
        }),
      ).toMatchObject({ kind: "unresolved", reason: "stale" });
    }
  });

  it("uses a uniquely validated warm recipe without a locator model call", async () => {
    const key = new Uint8Array(32).fill(9);
    const selected = candidate(1, {
      name: "Add to cart",
      peers: ["Camera"],
      signals: { path: "article/button", contextComplete: true },
    });
    const other = candidate(2, {
      name: "Add to cart",
      peers: ["Phone"],
      signals: { path: "article:2/button", contextComplete: true },
    });
    const entry = stageEntry(
      key,
      initial.route,
      "click",
      "Add Camera to cart",
      selected,
      {
        protocol: 1,
        version: initial,
        total: 2,
        offset: 0,
        next: null,
        complete: true,
        candidates: [selected, other],
      },
    );
    const model = resolver((options) => answer(options, "r1"));
    const store: CacheStore = {
      key,
      lookup: vi.fn(async () => ({ entry })),
      put: vi.fn(async () => {}),
      invalidate: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const result = await resolveTarget(
      recordedPage([selected, other]).page,
      model,
      {
        operation: "click",
        sentence: "Add Camera to cart",
        cache: store,
      },
    );
    expect(result).toMatchObject({
      kind: "resolved",
      cache: { outcome: "hit", fallbackCalledModel: false },
      calls: [],
    });
    expect(model.choose).not.toHaveBeenCalled();
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe("r1");

    const stale = await resolveTarget(recordedPage([other]).page, model, {
      operation: "click",
      sentence: "Add Camera to cart",
      cache: store,
    });
    expect(stale).toMatchObject({
      cache: { outcome: "miss", fallbackCalledModel: true },
    });
    expect(model.choose).toHaveBeenCalledTimes(1);
    expect(store.invalidate).toHaveBeenCalledWith(
      pageKey(key, initial.route, "click", "Add Camera to cart"),
      entry,
    );

    const dependent = await resolveTarget(
      recordedPage([selected, other]).page,
      model,
      {
        operation: "click",
        sentence: "Add Camera to cart",
        cache: store,
        runtimeDependent: true,
      },
    );
    expect(dependent).toMatchObject({
      kind: "resolved",
      cache: {
        outcome: "bypassed",
        reason: "runtime_dependent",
        fallbackCalledModel: true,
      },
    });
    if (dependent.kind === "resolved")
      expect(dependent.cacheSeed).toBeUndefined();
  });

  it("reports CI bypass while normal resolution still calls the model", async () => {
    const model = resolver((options) => answer(options, "r1"));
    const result = await resolveTarget(
      recordedPage([candidate(1)]).page,
      model,
      {
        operation: "click",
        sentence: "Item 1",
        cache: new NoopCacheStore("ci_default"),
      },
    );
    expect(result).toMatchObject({
      kind: "resolved",
      cache: {
        outcome: "bypassed",
        reason: "ci_default",
        fallbackCalledModel: true,
      },
    });
    expect(model.choose).toHaveBeenCalledTimes(1);
  });

  it("does not claim a changed target from a renamed hook", async () => {
    const key = new Uint8Array(32).fill(8);
    const old = candidate(1, {
      name: "Add to cart",
      peers: ["Camera"],
      signals: {
        hook: "old-camera-action",
        path: "article/button",
        contextComplete: true,
      },
    });
    const current = {
      ...old,
      signals: { ...old.signals, hook: "new-camera-action" },
    };
    const entry = stageEntry(
      key,
      initial.route,
      "click",
      "Add Camera to cart",
      old,
      {
        protocol: 1,
        version: initial,
        total: 1,
        offset: 0,
        next: null,
        complete: true,
        candidates: [old],
      },
    );
    const store: CacheStore = {
      key,
      lookup: vi.fn(async () => ({ entry })),
      put: vi.fn(async () => {}),
      invalidate: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const model = resolver((options) => answer(options, "r1"));
    const result = await resolveTarget(recordedPage([current]).page, model, {
      operation: "click",
      sentence: "Add Camera to cart",
      cache: store,
    });
    expect(result).toMatchObject({
      kind: "resolved",
      cache: {
        outcome: "miss",
        reason: "strong_signal_conflict",
        fallbackCalledModel: true,
        targetChanged: false,
      },
    });
  });

  it("checks a competing candidate beyond the first 128 before claiming a hit", async () => {
    const key = new Uint8Array(32).fill(6);
    const selected = candidate(0, {
      name: "Add to cart",
      peers: ["Camera"],
      signals: { path: "article/button", contextComplete: true },
    });
    const entry = stageEntry(
      key,
      initial.route,
      "click",
      "Add Camera to cart",
      selected,
      {
        protocol: 1,
        version: initial,
        total: 1,
        offset: 0,
        next: null,
        complete: true,
        candidates: [selected],
      },
    );
    const items = [
      selected,
      ...Array.from({ length: 127 }, (_, index) => candidate(index + 1)),
      { ...selected, ref: "r128" },
    ];
    const store: CacheStore = {
      key,
      lookup: vi.fn(async () => ({ entry })),
      put: vi.fn(async () => {}),
      invalidate: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const model = resolver((offered) => {
      const first = offered.options.find(
        (option) => option.kind === "candidate",
      );
      return answer(
        offered,
        first?.kind === "candidate" ? first.candidate.id : "none",
      );
    });
    const result = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "Add Camera to cart",
      cache: store,
    });
    expect(result.cache).toMatchObject({
      outcome: "miss",
      reason: "near_tie",
      fallbackCalledModel: true,
    });
    expect(model.choose).toHaveBeenCalled();
  });

  it("keeps unknown-cost failed resolver attempts in its receipt", async () => {
    const { page } = recordedPage([candidate(1)]);
    const result = await resolveTarget(
      page,
      {
        choose: vi.fn(async () => {
          throw new ProviderError("retry-exhausted", "Unavailable", 3);
        }),
      },
      { operation: "click", sentence: "Item 1" },
    );
    expect(result).toMatchObject({
      kind: "unresolved",
      reason: "provider_error",
      calls: [{ attempts: 3, totalCostUsd: null }],
    });
  });

  it("keeps the actual receipt when a resolver response is invalid", async () => {
    const { page } = recordedPage([candidate(0)]);
    const result = await resolveTarget(
      page,
      resolver((options) => ({
        ...answer(options, "r0"),
        probabilities: { r0: 1 },
      })),
      { operation: "click", sentence: "Item 0" },
    );
    expect(result).toMatchObject({
      kind: "unresolved",
      reason: "provider_error",
      calls: [call],
    });
  });

  it("keeps a Resolver receipt when cancellation lands after its response", async () => {
    const controller = new AbortController();
    const { page } = recordedPage([candidate(0)]);
    const result = await resolveTarget(
      page,
      resolver((options) => {
        controller.abort();
        return answer(options, "r0");
      }),
      {
        operation: "click",
        sentence: "Item 0",
        signal: controller.signal,
      },
    );
    expect(result).toMatchObject({
      kind: "unresolved",
      reason: "timeout",
      calls: [call],
    });
  });

  it.each([0, 1, 128, 129, 255, 256, 1780])(
    "collects %i candidates and compares finalists",
    async (count) => {
      const items = Array.from({ length: count }, (_, index) =>
        candidate(index),
      );
      const { page } = recordedPage(items);
      const target = `r${count - 1}`;
      const model = resolver((offered) => {
        const ids = offered.options
          .filter((option) => option.kind === "candidate")
          .map((option) => option.candidate.id);
        return answer(offered, ids.includes(target) ? target : ids[0]!);
      });
      const result = await resolveTarget(page, model, {
        operation: "click",
        sentence: `Item ${count - 1}`,
      });
      if (!count)
        expect(result).toMatchObject({
          kind: "unresolved",
          reason: "no_candidates",
        });
      else {
        expect(result.kind).toBe("resolved");
        if (result.kind === "resolved")
          expect(result.target.driverTarget().ref).toBe(`fresh-${target}`);
        expect(result.calls).toHaveLength(
          count <= 128 ? 1 : Math.ceil(count / 128) + 1,
        );
        expect(
          result.diagnostic.topOptions.some(
            (option) => option.name === "(no match)",
          ),
        ).toBe(true);
      }
    },
  );

  it("recursively compares valid long Unicode candidates at the 4096 ceiling", async () => {
    const text = "😀".repeat(116);
    const peer = "😀".repeat(80);
    const items = Array.from({ length: 4096 }, (_, index) =>
      candidate(index, { name: `${text}${index}`, peers: [peer, peer] }),
    );
    const { page } = recordedPage(items);
    const target = "r4095";
    const offeredSizes: number[] = [];
    const model = resolver((offered) => {
      const ids = offered.options
        .filter((option) => option.kind === "candidate")
        .map((option) => option.candidate.id);
      offeredSizes.push(ids.length);
      return answer(offered, ids.includes(target) ? target : ids[0]!);
    });
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "Select the last item",
    });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe("fresh-r4095");
    expect(offeredSizes.length).toBeGreaterThan(80);
    expect(Math.max(...offeredSizes)).toBeLessThanOrEqual(128);
    expect(result.calls).toHaveLength(offeredSizes.length);
  }, 30_000);

  it("rejects over-ceiling, incomplete and corrupt cursor sets before model calls", async () => {
    const model = resolver((options) => answer(options, "none"));
    const huge = recordedPage(
      Array.from({ length: 4097 }, (_, i) => candidate(i)),
    );
    expect(
      await resolveTarget(huge.page, model, {
        operation: "click",
        sentence: "x",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "resource_limit" });
    const items = Array.from({ length: 129 }, (_, i) => candidate(i));
    const corrupt = recordedPage(items, {
      corrupt: (page) =>
        page.offset ? { ...page, candidates: [items[0]!] } : page,
    });
    expect(
      await resolveTarget(corrupt.page, model, {
        operation: "click",
        sentence: "x",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "incomplete" });
    expect(model.choose).not.toHaveBeenCalled();
  });

  it("keeps two finalists even when preliminary none wins, and accepts final none", async () => {
    const { page } = recordedPage(
      Array.from({ length: 129 }, (_, i) => candidate(i)),
    );
    const sizes: number[] = [];
    const model = resolver((options) => {
      sizes.push(options.options.length);
      const ids = options.options
        .filter((option) => option.kind === "candidate")
        .map((option) => option.candidate.id);
      if (sizes.length < 3) {
        const probabilities = Object.fromEntries(
          ids.map((id, i) => [id, i < 2 ? 0.2 : 0]),
        ) as Record<string, number>;
        probabilities.none = ids.length === 1 ? 0.8 : 0.6;
        return answer(options, "none", probabilities);
      }
      return answer(options, "none");
    });
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "missing",
    });
    expect(result).toMatchObject({ kind: "unresolved", reason: "none" });
    expect(sizes).toEqual([129, 2, 4]);
    expect(result.calls).toHaveLength(3);
  });

  it("rejects null-confidence near ties and low provider confidence", async () => {
    const { page } = recordedPage([candidate(0), candidate(1)]);
    const near = resolver((options) =>
      answer(options, "r0", { r0: 0.44, r1: 0.43, none: 0.13 }),
    );
    expect(
      await resolveTarget(page, near, { operation: "click", sentence: "Item" }),
    ).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
    const low = resolver((options) =>
      answer(options, "r0", { r0: 0.8, r1: 0.1, none: 0.1 }, 0.2),
    );
    expect(
      await resolveTarget(page, low, { operation: "click", sentence: "Item" }),
    ).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
  });

  it("accepts a below-30% winner only when its lead is sufficient", async () => {
    const { page } = recordedPage(
      Array.from({ length: 5 }, (_, index) => candidate(index)),
    );
    for (const [runnerUp, fifth, accepted] of [
      [0.17, 0.13, true],
      [0.2, 0.1, false],
    ] as const) {
      const model = resolver((options) =>
        answer(
          options,
          "r0",
          { r0: 0.29, r1: runnerUp, r2: 0.16, r3: 0.15, r4: fifth, none: 0.1 },
          0.8,
        ),
      );
      const result = await resolveTarget(page, model, {
        operation: "click",
        sentence: "Item 0",
      });
      if (accepted) {
        expect(result.kind).toBe("resolved");
        if (result.kind === "resolved")
          expect(result.target.driverTarget().ref).toBe("fresh-r0");
      } else {
        expect(result).toMatchObject({
          kind: "unresolved",
          reason: "ambiguous",
        });
      }
    }
  });

  it("requires member-specific evidence for repeated labels and hrefs", async () => {
    const items = [
      candidate(0, {
        name: "Add to cart",
        peers: ["Camera"],
        signals: { path: "a", href: "/cart" },
      }),
      candidate(1, {
        name: "Add to cart",
        peers: ["Phone"],
        signals: { path: "b", href: "/cart" },
      }),
      candidate(2),
    ];
    const { page } = recordedPage(items);
    let rounds = 0;
    const model = resolver((options) => {
      rounds++;
      return rounds % 2 === 1
        ? answer(options, "r0", { r0: 0.43, r1: 0.42, r2: 0.05, none: 0.1 })
        : answer(options, "r0", { r0: 0.8, r1: 0.1, none: 0.1 });
    });
    const clear = await resolveTarget(page, model, {
      operation: "click",
      repeatedMember: {},
      sentence: "Add Camera to cart",
    });
    expect(clear.kind).toBe("resolved");
    expect(clear.calls).toHaveLength(2);
    const vague = await resolveTarget(page, model, {
      operation: "click",
      repeatedMember: {},
      sentence: "Add to cart",
    });
    expect(vague).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
  });

  it("lets a narrower Choice select the named member after a different preliminary winner", async () => {
    const items = [
      candidate(0, { name: "Add to cart", peers: ["Camera"] }),
      candidate(1, { name: "Add to cart", peers: ["Phone"] }),
    ];
    const { page } = recordedPage(items);
    let choices = 0;
    const model = resolver((offered) => {
      choices++;
      return choices === 1
        ? answer(offered, "r0", { r0: 0.43, r1: 0.42, none: 0.15 })
        : answer(offered, "r1", { r0: 0.1, r1: 0.85, none: 0.05 });
    });
    const result = await resolveTarget(page, model, {
      operation: "click",
      repeatedMember: {},
      sentence: "Add Phone to cart",
    });
    expect(result.kind).toBe("resolved");
    expect(result.calls).toHaveLength(2);
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe("fresh-r1");
  });

  it("rejects a confident choice among same-label controls when the sentence is vague", async () => {
    const items = [
      candidate(0, {
        name: "Add to cart",
        peers: ["Camera"],
        signals: { path: "camera", href: "/cart" },
      }),
      candidate(1, {
        name: "Add to cart",
        peers: ["Phone"],
        signals: { path: "phone", href: "/cart" },
      }),
    ];
    const { page } = recordedPage(items);
    const model = resolver((options) =>
      answer(options, "r0", { r0: 0.8, r1: 0.1, none: 0.1 }, 0.9),
    );
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence: "Add to cart",
      }),
    ).toMatchObject({
      kind: "unresolved",
      reason: "ambiguous",
      diagnostic: { gate: "repeated_member_no_evidence" },
    });
    expect(
      (
        await resolveTarget(page, model, {
          operation: "click",
          repeatedMember: {},
          sentence: "Add Camera to cart",
        })
      ).kind,
    ).toBe("resolved");
  });

  it("resolves ordinals, prices, and row references in code", async () => {
    const items = [
      candidate(0, {
        name: "Add to cart",
        peers: ["Trail Light"],
        signals: { path: "a", item: "Trail Light $49.00 Add to cart" },
      }),
      candidate(1, {
        name: "Add to cart",
        peers: ["Camp Mug"],
        signals: { path: "b", item: "Camp Mug $12.00 Add to cart" },
      }),
      candidate(2, {
        name: "Add to cart",
        peers: ["Grace Hopper"],
        signals: { path: "c", item: "Grace Hopper Mug $20.00 Add to cart" },
      }),
    ];
    const { page } = recordedPage(items);
    // The model always prefers the first card; code overrides it.
    const model = resolver((options) =>
      answer(options, "r0", { r0: 0.9, r1: 0.04, r2: 0.03, none: 0.03 }, 0.9),
    );
    const picked = async (sentence: string) => {
      const result = await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence,
      });
      return result.kind === "resolved"
        ? result.target.driverTarget().ref
        : result.reason;
    };
    expect(await picked("click the second Add to cart button")).toBe(
      "fresh-r1",
    );
    expect(await picked("click the last Add to cart button")).toBe("fresh-r2");
    expect(await picked("click Add to cart for the cheapest product")).toBe(
      "fresh-r1",
    );
    expect(await picked("click Add to cart for Grace Hopper")).toBe("fresh-r2");
    // A reference no item holds, or a qualifier code cannot check, falls
    // back to the model and the gate.
    expect(await picked("click Add to cart for Wool Socks")).toBe("ambiguous");
    expect(await picked("click the first non-sponsored Add to cart")).toBe(
      "ambiguous",
    );
  });

  it.each([
    "cheapest red mug",
    "click Add to cart for the cheapest red mug",
    "click the second Add to cart button that is red",
    "click Add to cart for the cheapest product with free shipping",
    "click the second Add to cart in Missing section",
    "do not click the first Add to cart button",
  ])(
    "does not override a model pick from a partial request: %s",
    async (sentence) => {
      const items = [
        candidate(0, {
          name: "Add to cart",
          signals: { path: "a", item: "Red mug $10 Add to cart" },
        }),
        candidate(1, {
          name: "Add to cart",
          signals: { path: "b", item: "Blue mug $5 Add to cart" },
        }),
      ];
      const { page } = recordedPage(items);
      const model = resolver((options) =>
        answer(options, "r0", { r0: 0.9, r1: 0.08, none: 0.02 }, 0.9),
      );
      const result = await resolveTarget(page, model, {
        operation: "click",
        sentence,
      });
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.target.driverTarget().ref).toBe("fresh-r0");
        expect(result.diagnostic.gate).not.toBe("resolved_in_code");
      }
    },
  );

  it.each([
    "click Add to cart for the cheapest red mug",
    "click the second Add to cart in Missing section",
  ])(
    "does not rescue model abstention with a partial match: %s",
    async (sentence) => {
      const { page } = recordedPage([
        candidate(0, {
          name: "Add to cart",
          signals: { path: "a", item: "Red mug $10" },
        }),
        candidate(1, {
          name: "Add to cart",
          signals: { path: "b", item: "Blue mug $5" },
        }),
      ]);
      const model = resolver((options) =>
        answer(options, "none", { r0: 0.04, r1: 0.04, none: 0.92 }, 0.92),
      );
      expect(
        await resolveTarget(page, model, { operation: "click", sentence }),
      ).toMatchObject({ kind: "unresolved", reason: "none" });
    },
  );

  it.each([
    ["click the second Edit in Billing", "fresh-r2"],
    ["click Edit for the cheapest item in Billing", "fresh-r2"],
    ["click the last Edit under Billing", "fresh-r2"],
  ])(
    "applies the section before counting or comparing: %s",
    async (sentence, expected) => {
      const items = [
        candidate(0, {
          name: "Edit",
          signals: { path: "a", section: "Account", item: "Account $1" },
        }),
        candidate(1, {
          name: "Edit",
          signals: {
            path: "b",
            section: "Settings › Billing",
            item: "Billing $20",
          },
        }),
        candidate(2, {
          name: "Edit",
          signals: {
            path: "c",
            section: "Settings › Billing",
            item: "Billing $10",
          },
        }),
      ];
      const { page } = recordedPage(items);
      const model = resolver((options) =>
        answer(options, "r0", { r0: 0.9, r1: 0.04, r2: 0.04, none: 0.02 }, 0.9),
      );
      const result = await resolveTarget(page, model, {
        operation: "click",
        sentence,
      });
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved")
        expect(result.target.driverTarget().ref).toBe(expected);
    },
  );

  it("counts only article-body members for an explicit article scope", async () => {
    const items = [
      candidate(0, {
        name: "Charles Babbage",
        tag: "a",
        role: "link",
        signals: { path: "sidebar" },
      }),
      candidate(1, {
        name: "Charles Babbage",
        tag: "a",
        role: "link",
        signals: { path: "body/1", region: "article-body" },
      }),
      candidate(2, {
        name: "Charles Babbage",
        tag: "a",
        role: "link",
        signals: { path: "body/2", region: "article-body" },
      }),
    ];
    const model = resolver((options) => answer(options, "r2"));
    const result = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "click the first Charles Babbage link in the article",
    });
    expect(result).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "resolved_in_code" },
    });
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
  });

  it("applies an explicit control kind before counting", async () => {
    const { page } = recordedPage([
      candidate(0, { name: "Edit", tag: "a", role: "link" }),
      candidate(1, { name: "Edit" }),
      candidate(2, { name: "Edit" }),
    ]);
    const model = resolver((options) => answer(options, "r2"));
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "click the second Edit button",
    });
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r2",
    );
  });

  it.each(["item", "section"] as const)(
    "rejects changed %s evidence before returning a code pick",
    async (signal) => {
      const items = [
        candidate(0, {
          name: "Edit",
          signals: { path: "a", section: "Billing", item: "$20" },
        }),
        candidate(1, {
          name: "Edit",
          signals: { path: "b", section: "Billing", item: "$10" },
        }),
      ];
      const { page } = recordedPage(items, {
        live: () =>
          items.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  signals: {
                    ...item.signals,
                    [signal]: signal === "item" ? "$1" : "Account",
                  },
                }
              : item,
          ),
      });
      const model = resolver((options) =>
        answer(options, "r0", { r0: 0.9, r1: 0.08, none: 0.02 }, 0.9),
      );
      expect(
        await resolveTarget(page, model, {
          operation: "click",
          sentence:
            signal === "item"
              ? "click Edit for the cheapest item"
              : "click the second Edit in Billing",
        }),
      ).toMatchObject({ kind: "unresolved", reason: "stale" });
    },
  );

  it("acts on the same-name member in the section the sentence names", async () => {
    const items = [
      candidate(0, {
        name: "Python for Everybody",
        signals: { path: "a", section: "Trending searches › Python" },
      }),
      candidate(1, {
        name: "Python for Everybody",
        signals: { path: "b", section: "Most popular › New and popular" },
      }),
    ];
    const { page } = recordedPage(items);
    const model = resolver((options) =>
      answer(options, "r0", { r0: 0.8, r1: 0.15, none: 0.05 }, 0.8),
    );
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "open Python for Everybody under Most popular",
    });
    expect(result).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "resolved_by_section" },
    });
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe("fresh-r1");
  });

  it("acts on the model's pick among repeated elements by default", async () => {
    const items = [
      candidate(0, { name: "Pricing", signals: { path: "nav", href: "/p" } }),
      candidate(1, { name: "Pricing", signals: { path: "foot", href: "/q" } }),
    ];
    const { page } = recordedPage(items);
    const model = resolver((options) =>
      answer(options, "r1", { r0: 0.3, r1: 0.6, none: 0.1 }, 0.6),
    );
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "click Pricing",
    });
    expect(result).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "repeated_member_model_pick" },
    });
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe("fresh-r1");
  });

  it("accepts a repeated member only under an opted-in policy", async () => {
    const items = [
      candidate(0, {
        name: "Pricing",
        peers: [],
        signals: { path: "nav", href: "/pricing" },
      }),
      candidate(1, {
        name: "Pricing",
        peers: [],
        signals: { path: "footer", href: "/pricing" },
      }),
      candidate(2, {
        name: "Edit",
        peers: ["Ada Lovelace"],
        signals: { path: "ada" },
      }),
      candidate(3, {
        name: "Edit",
        peers: ["Grace Hopper"],
        signals: { path: "grace" },
      }),
    ];
    const { page } = recordedPage(items);
    const pricing = resolver((options) =>
      answer(
        options,
        "r0",
        { r0: 0.6, r1: 0.35, r2: 0, r3: 0, none: 0.05 },
        0.9,
      ),
    );
    const vague = {
      operation: "click" as const,
      sentence: "click Pricing",
      repeatedMember: {},
    };
    expect(await resolveTarget(page, pricing, vague)).toMatchObject({
      kind: "unresolved",
      diagnostic: { gate: "repeated_member_no_evidence" },
    });
    expect(
      await resolveTarget(page, pricing, {
        ...vague,
        repeatedMember: { sameDestination: true },
      }),
    ).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "repeated_member_same_destination" },
    });
    const edit = resolver((options) =>
      answer(
        options,
        "r3",
        { r0: 0, r1: 0, r2: 0.05, r3: 0.9, none: 0.05 },
        0.95,
      ),
    );
    const paraphrase = {
      operation: "click" as const,
      repeatedMember: {},
      sentence: "edit the second team member",
    };
    const trust = { minProbability: 0.7, minLead: 0.3 };
    expect(
      await resolveTarget(page, edit, {
        ...paraphrase,
        repeatedMember: { sameDestination: true },
      }),
    ).toMatchObject({ kind: "unresolved" });
    expect(
      await resolveTarget(page, edit, {
        ...paraphrase,
        repeatedMember: { trust },
      }),
    ).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "repeated_member_trusted" },
    });
    expect(
      await resolveTarget(page, edit, {
        ...paraphrase,
        repeatedMember: { trust: { minProbability: 0.95, minLead: 0.3 } },
      }),
    ).toMatchObject({ kind: "unresolved" });
    // A sentence that only repeats the shared label is a guess however sure
    // the model is.
    expect(
      await resolveTarget(page, edit, {
        operation: "click",
        sentence: "click the Edit button",
        repeatedMember: { trust },
      }),
    ).toMatchObject({
      kind: "unresolved",
      diagnostic: { gate: "repeated_member_no_evidence" },
    });
  });

  it("does not treat a generic category word as evidence for one product", async () => {
    const items = [
      candidate(0, {
        name: "Add to cart",
        peers: ["Product Camera"],
        signals: { path: "camera" },
      }),
      candidate(1, {
        name: "Add to cart",
        peers: ["Phone"],
        signals: { path: "phone" },
      }),
    ];
    const { page } = recordedPage(items);
    const model = resolver((options) =>
      answer(options, "r0", { r0: 0.9, r1: 0.05, none: 0.05 }, 0.95),
    );
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence: "Add to cart for the product",
      }),
    ).toMatchObject({
      kind: "unresolved",
      reason: "ambiguous",
      diagnostic: { gate: "repeated_member_no_evidence" },
    });
    expect(
      (
        await resolveTarget(page, model, {
          operation: "click",
          repeatedMember: {},
          sentence: "Add to cart for Product Camera",
        })
      ).kind,
    ).toBe("resolved");
  });

  it("accepts an explicitly named generic label among repeated destinations", async () => {
    const { page } = recordedPage([
      candidate(0, {
        name: "More",
        signals: { path: "more", href: "/article" },
      }),
      candidate(1, {
        name: "Read article",
        signals: { path: "read", href: "/article" },
      }),
    ]);
    const model = resolver((options) => answer(options, "r0"));
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "click More",
    });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved")
      expect(result.target.driverTarget().ref).toBe("fresh-r0");
  });

  it("combines first-story rank and link purpose for repeated destinations", async () => {
    const items = [
      candidate(0, {
        tag: "a",
        role: "link",
        name: "306 comments",
        peers: ["1. Story One"],
        signals: { path: "first", href: "/comments/1" },
      }),
      candidate(1, {
        tag: "a",
        role: "link",
        name: "7 hours ago",
        peers: ["1. Story One"],
        signals: { path: "other", href: "/comments/1" },
      }),
      candidate(2, {
        tag: "a",
        role: "link",
        name: "12 comments",
        peers: ["2. Story Two"],
        signals: { path: "second", href: "/comments/2" },
      }),
    ];
    const { page } = recordedPage(items);
    const model = resolver((options) =>
      answer(options, "r0", { r0: 0.9, r1: 0.03, r2: 0.02, none: 0.05 }, 0.95),
    );
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence: "the comments link for the first story in the list",
      }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence: "the comments link for the first ranked story",
      }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence: "the comments link",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        repeatedMember: {},
        sentence: "the first story link",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
  });

  it("never hands a fallback label to fill and accepts an executable field", async () => {
    const label = candidate(0, { tag: "label", role: "", name: "Email" });
    const fallback = recordedPage([label], { fill: [] });
    const model = resolver((options) => answer(options, "r0"));
    expect(
      await resolveTarget(fallback.page, model, {
        operation: "fill",
        sentence: "Email",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "not_fillable" });
    const field = candidate(0, {
      tag: "input",
      role: "textbox",
      name: "Email",
      editable: true,
      inputType: "email",
    });
    const actual = recordedPage([field], { fill: [field] });
    expect(
      (
        await resolveTarget(actual.page, model, {
          operation: "fill",
          sentence: "Email",
        })
      ).kind,
    ).toBe("resolved");
  });

  it("rejects over-limit candidate text before a model request", async () => {
    const longName = "Article ".repeat(20);
    const item = candidate(0, {
      name: longName,
      peers: ["Detail ".repeat(20)],
    });
    const { page } = recordedPage([item]);
    const model = resolver((options) => answer(options, "r0"));
    const result = await resolveTarget(page, model, {
      operation: "click",
      sentence: "Article",
    });
    expect(result).toMatchObject({
      kind: "unresolved",
      reason: "request_too_large",
      diagnostic: { candidateCount: 1 },
    });
    expect(model.choose).not.toHaveBeenCalled();
  });

  it("delegates region interpretation to the resolver but still disambiguates repeated labels", async () => {
    const navigation = candidate(0, {
      tag: "a",
      role: "link",
      name: "comments",
      peers: ["navigation"],
      signals: { path: "nav" },
    });
    const story = candidate(1, {
      tag: "a",
      role: "link",
      name: "20 comments",
      peers: ["1. Story One"],
      signals: { path: "story" },
    });
    const { page } = recordedPage([navigation, story]);
    const wrong = resolver((options) => answer(options, "r0"));
    // Semantic correctness belongs to the resolver, not a phrase-specific veto.
    const selected = await resolveTarget(page, wrong, {
      operation: "click",
      sentence: "comments for the first story",
    });
    expect(selected.kind).toBe("resolved");
    if (selected.kind === "resolved")
      expect(selected.target.driverTarget().ref).toBe("fresh-r0");
    const correct = resolver((options) => answer(options, "r1"));
    expect(
      (
        await resolveTarget(page, correct, {
          operation: "click",
          sentence: "comments for the first story",
        })
      ).kind,
    ).toBe("resolved");
    const sidebar = candidate(0, {
      tag: "a",
      role: "link",
      name: "Charles Babbage",
      signals: { path: "sidebar" },
    });
    const body = candidate(1, {
      tag: "a",
      role: "link",
      name: "Charles Babbage",
      signals: { path: "article", id: "body-link", region: "article-body" },
    });
    const article = recordedPage([sidebar, body]);
    expect(
      await resolveTarget(article.page, wrong, {
        operation: "click",
        sentence: "Charles Babbage in the article body",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
    expect(
      (
        await resolveTarget(article.page, correct, {
          operation: "click",
          sentence: "Charles Babbage in the article body",
        })
      ).kind,
    ).toBe("resolved");
  });

  it("accepts a unique same-route rerender and rejects a route change or duplicate clone", async () => {
    const items = [candidate(0, { signals: { path: "a", id: "buy" } })];
    const model = resolver((options) => answer(options, "r0"));
    const rerender = recordedPage(items, {
      onLive: () => rerender.setVersion({ ...initial, revision: 2 }),
    });
    const success = await resolveTarget(rerender.page, model, {
      operation: "click",
      sentence: "Buy",
    });
    expect(success.kind).toBe("resolved");
    const route = recordedPage(items, {
      onLive: () =>
        route.setVersion({ ...initial, route: "https://fixture.test/other" }),
    });
    expect(
      await resolveTarget(route.page, model, {
        operation: "click",
        sentence: "Buy",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "stale" });
    const duplicate = recordedPage(items, {
      live: () => [items[0]!, { ...items[0]!, ref: "r1" }],
    });
    expect(
      await resolveTarget(duplicate.page, model, {
        operation: "click",
        sentence: "Buy",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "stale" });
  });

  it("rejects a requested article-body target that moves to a sidebar", async () => {
    const original = candidate(0, {
      tag: "a",
      role: "link",
      name: "Charles Babbage",
      peers: ["article"],
      signals: {
        path: "main/a",
        href: "/wiki/Charles_Babbage",
        region: "article-body",
      },
    });
    const moved = {
      ...original,
      signals: { path: "aside/a", href: "/wiki/Charles_Babbage" },
    };
    const setup = recordedPage([original], {
      onLive: () => setup.setVersion({ ...initial, revision: 2 }),
      live: () => [moved],
    });
    const model = resolver((options) => answer(options, "r0"));
    expect(
      await resolveTarget(setup.page, model, {
        operation: "click",
        sentence: "Charles Babbage in the article body",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "stale" });
  });

  it("does not return an actionable target after the deadline expires during refresh", async () => {
    const base = recordedPage([candidate(0)]);
    const page = {
      ...base.page,
      evaluate: vi.fn(async (expression: string) => {
        if (expression.includes('bridge["findBySignals"]'))
          await new Promise((resolve) => setTimeout(resolve, 30));
        return base.evaluate(expression);
      }),
    } as BrowserPage;
    const model = resolver((options) => answer(options, "r0"));
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        sentence: "Item 0",
        timeoutMs: 10,
      }),
    ).toMatchObject({ kind: "unresolved", reason: "timeout" });
  });

  it("fails closed on a changed target during Choice and on cancellation", async () => {
    const items = [candidate(0)];
    const changing = recordedPage(items, {
      live: () => [candidate(0, { name: "Different item" })],
    });
    const model = resolver((options) => {
      changing.setVersion({ ...initial, revision: 2 });
      return answer(options, "r0");
    });
    expect(
      await resolveTarget(changing.page, model, {
        operation: "click",
        sentence: "Item 0",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "stale" });
    const controller = new AbortController();
    controller.abort();
    const idle = resolver((options) => answer(options, "r0"));
    expect(
      await resolveTarget(recordedPage(items).page, idle, {
        operation: "click",
        sentence: "Item 0",
        signal: controller.signal,
      }),
    ).toMatchObject({ kind: "unresolved", reason: "timeout" });
    expect(idle.choose).not.toHaveBeenCalled();
  });
});

describe("name hints, item checks, and code fallback", () => {
  const post = (index: number, title: string, name = "Share") =>
    candidate(index, {
      name,
      signals: {
        path: `body/article:${index}/button`,
        item: `${title} u/author ${index} hr. ago`,
      },
    });

  it("projects name hints by default and not when turned off", async () => {
    const items = [
      candidate(0, {
        name: "Stripe Assistant",
        signals: { path: "body/a:0", nameHint: 'shows "Ask AI"' },
      }),
      candidate(1, { name: "Docs" }),
    ];
    const seen: string[][] = [];
    const model = resolver((options) => {
      seen.push(
        options.options.flatMap((option) =>
          option.kind === "candidate" ? [option.candidate.name] : [],
        ),
      );
      return answer(options, "r0");
    });
    await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "click Ask AI",
      nameHints: false,
    });
    await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "click Ask AI",
    });
    expect(seen[0]).toEqual(["Stripe Assistant", "Docs"]);
    expect(seen[1]).toEqual(['Stripe Assistant (shows "Ask AI")', "Docs"]);
  });

  it("acts on a clear per-item winner and falls back otherwise", async () => {
    const items = [
      post(0, "Microservices are organizational debt"),
      post(1, "We still maintain a development tool first released in 1993"),
      post(2, "How we saved memory in a DNS cache"),
    ];
    const sentence =
      "click Share on the post about a tool that has been around for decades";
    const verify = vi.fn(
      async (_s: string, list: readonly { id: string }[]) => ({
        scores: Object.fromEntries(
          list.map((item) => [item.id, item.id === "r1" ? 0.9 : 0.1]),
        ),
        call,
      }),
    );
    const model: Resolver = {
      choose: vi.fn(async (_s, options) => answer(options, "r0")),
      verifyItems: verify,
    };
    const result = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence,
      verifyItems: true,
    });
    expect(result).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "resolved_by_items" },
    });
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![1].map((item) => item.id)).toEqual([
      "r0",
      "r1",
      "r2",
    ]);

    const unsure: Resolver = {
      choose: vi.fn(async (_s, options) => answer(options, "r0")),
      verifyItems: vi.fn(
        async (_s: string, list: readonly { id: string }[]) => ({
          scores: Object.fromEntries(list.map((item) => [item.id, 0.5])),
          call,
        }),
      ),
    };
    const fallback = await resolveTarget(recordedPage(items).page, unsure, {
      operation: "click",
      sentence,
      verifyItems: true,
    });
    expect(fallback.kind === "resolved" && fallback.diagnostic.gate).toBe(
      "repeated_member_model_pick",
    );

    const failing: Resolver = {
      choose: vi.fn(async (_s, options) => answer(options, "r0")),
      verifyItems: vi.fn(async () => {
        throw new ProviderError("connection", "down");
      }),
    };
    expect(
      await resolveTarget(recordedPage(items).page, failing, {
        operation: "click",
        sentence,
        verifyItems: true,
      }),
    ).toMatchObject({ kind: "resolved" });
  });

  it("does not ask about items for ordinals or without the flag", async () => {
    const items = [post(0, "Alpha story"), post(1, "Beta story")];
    const verify = vi.fn();
    const model: Resolver = {
      choose: vi.fn(async (_s, options) => answer(options, "r0")),
      verifyItems: verify,
    };
    await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "click Share on the first post",
      verifyItems: true,
    });
    await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "click Share on the post about beta",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("matches counted names and references loosely unless codeFallback is off", async () => {
    const items = [
      post(0, "Microservices are organizational debt", "131 Go to comments"),
      post(
        1,
        "How we saved 100 terabytes by optimizing DNS cache",
        "53 Go to comments",
      ),
    ];
    const model = resolver((options) => answer(options, "r0"));
    const sentence = "open the comments for the DNS cache post";
    const strict = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence,
      codeFallback: false,
    });
    expect(strict.kind === "resolved" && strict.target.driverTarget().ref).toBe(
      "fresh-r0",
    );
    const loose = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence,
    });
    expect(loose).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "resolved_in_code" },
    });
    expect(loose.kind === "resolved" && loose.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
  });

  it("counts all masked siblings, not only identical numeric labels", async () => {
    const items = [84, 62, 62].map((count, index) =>
      candidate(index, {
        name: `${count} comments`,
        tag: "a",
        role: "link",
        signals: { path: `story/${index}` },
      }),
    );
    const model = resolver((options) => answer(options, "r1"));
    const result = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence: "click the comments link for the second story",
    });
    expect(result).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "resolved_in_code" },
    });
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
  });

  it("counts when the control name is used as the action", async () => {
    const { page } = recordedPage([
      candidate(0, { name: "Upvote" }),
      candidate(1, { name: "Upvote" }),
    ]);
    const result = await resolveTarget(
      page,
      resolver((options) => answer(options, "none")),
      {
        operation: "click",
        sentence: "upvote the first post",
      },
    );
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r0",
    );
  });

  it.each([
    [
      "click Share on the post about a development tool first released in 1993",
      "fresh-r0",
    ],
    [
      "click the first red Share on the post about a development tool first released in 1993",
      "fresh-r1",
    ],
    [
      "click Share on the first red post about a development tool released in 1993",
      "fresh-r1",
    ],
  ])(
    "distinguishes an item reference from a target ordinal: %s",
    async (sentence, expected) => {
      const { page } = recordedPage([
        candidate(0, {
          name: "Share",
          signals: {
            path: "a",
            item: "A red development tool first released in 1993",
          },
        }),
        candidate(1, {
          name: "Share",
          signals: { path: "b", item: "A different development tool" },
        }),
      ]);
      const result = await resolveTarget(
        page,
        resolver((options) => answer(options, "r1")),
        {
          operation: "click",
          sentence,
        },
      );
      expect(
        result.kind === "resolved" && result.target.driverTarget().ref,
      ).toBe(expected);
    },
  );

  it("counts in code after the model answers none unless codeFallback is off", async () => {
    const items = [0, 1, 2, 3].map((index) =>
      candidate(index, {
        name: "View Product",
        tag: "a",
        role: "link",
        signals: { path: `body/li:${index}/a`, href: `/p/${index}` },
      }),
    );
    const model = resolver((options) => answer(options, "none"));
    const sentence = "click View Product on the third product";
    expect(
      await resolveTarget(recordedPage(items).page, model, {
        operation: "click",
        sentence,
        codeFallback: false,
      }),
    ).toMatchObject({ kind: "unresolved", reason: "none" });
    const result = await resolveTarget(recordedPage(items).page, model, {
      operation: "click",
      sentence,
    });
    expect(result).toMatchObject({
      kind: "resolved",
      diagnostic: { gate: "resolved_in_code_after_none" },
    });
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r2",
    );
  });
});

describe("vision fallback boundaries", () => {
  const items = [
    candidate(0, { name: "Edit" }),
    candidate(1, { name: "Edit" }),
  ];
  function setup(observed = items) {
    const page = recordedPage(observed);
    vi.mocked(captureVisionObservation).mockClear();
    vi.mocked(captureVisionObservation).mockResolvedValue({
      candidates: observed,
      observation: {
        instruction: "click the right Edit",
        image: new Uint8Array(),
        candidates: observed.map((item, i) => ({
          id: `C${i + 1}`,
          name: item.name,
          role: item.role,
        })),
      },
    });
    const vision: VisionResolver = {
      choose: vi.fn(async () => ({
        decision: { kind: "candidate" as const, id: "C2" },
        call,
      })),
    };
    const jev = resolver((options) => answer(options, "r0"));
    return { ...page, vision, jev };
  }
  it.each([false, true])(
    "distinguishes inconclusive item verification from failure=%s",
    async (fails) => {
      const cards = items.map((item, index) => ({
        ...item,
        signals: {
          ...item.signals,
          item: index
            ? "A development tool maintained since 1993"
            : "An article about DNS caches",
        },
      }));
      const { vision, jev } = setup(cards);
      const verifyItems = vi.fn(async () => {
        if (fails)
          throw new ProviderError(
            "connection",
            "private upstream body",
            1,
            call,
          );
        return { scores: { r0: 0.5, r1: 0.5 }, call };
      });
      const result = await resolveTarget(
        recordedPage(cards).page,
        { ...jev, verifyItems },
        {
          operation: "click",
          sentence:
            "click Edit on the card about a tool that has been around for decades",
          visionResolver: vision,
        },
      );
      expect(verifyItems).toHaveBeenCalledTimes(1);
      if (fails) {
        expect(result).toMatchObject({
          kind: "unresolved",
          reason: "provider_error",
          calls: [call, call],
        });
        expect(captureVisionObservation).not.toHaveBeenCalled();
        expect(vision.choose).not.toHaveBeenCalled();
      } else {
        expect(
          result.kind === "resolved" && result.target.driverTarget().ref,
        ).toBe("fresh-r1");
        expect(vision.choose).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(["throw", "null"])(
    "reports a stale %s capture before spending the vision request",
    async (mode) => {
      const { vision, jev } = setup();
      const recorded = recordedPage(items);
      // The page settles after the text model answered: its revision moves
      // and either the snapshot check throws or capture declines the frame.
      vi.mocked(captureVisionObservation).mockImplementationOnce(async () => {
        recorded.setVersion({ ...initial, revision: initial.revision + 1 });
        if (mode === "null") return null;
        throw new Error("stale visual observation");
      });
      const result = await resolveTarget(recorded.page, jev, {
        operation: "click",
        sentence: "click the Edit next to the mountain photo",
        visionResolver: vision,
      });
      expect(result).toMatchObject({
        kind: "unresolved",
        reason: "stale",
        diagnostic: {
          gate: "repeated_member_no_evidence:vision_stale_capture",
        },
      });
      expect(vision.choose).not.toHaveBeenCalled();
    },
  );
  it("offers count-varying controls with distinct destinations to vision", async () => {
    const links = items.map((item, index) => ({
      ...item,
      tag: "a",
      role: "link",
      name: index ? "12 comments" : "306 comments",
      signals: { ...item.signals, href: `/story/${index}` },
    }));
    const { vision, jev } = setup(links);
    const result = await resolveTarget(recordedPage(links).page, jev, {
      operation: "click",
      sentence: "open comments for the article with the mountain photo",
      visionResolver: vision,
    });
    expect(vision.choose).toHaveBeenCalledTimes(1);
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
  });
  it("preserves permissive picks without vision and explicit core policy precedence", async () => {
    const { vision, jev } = setup();
    for (const options of [
      {},
      { visionResolver: vision, repeatedMember: { modelPick: true } },
    ]) {
      const result = await resolveTarget(recordedPage(items).page, jev, {
        operation: "click",
        sentence: "click Edit",
        ...options,
      });
      expect(
        result.kind === "resolved" && result.target.driverTarget().ref,
      ).toBe("fresh-r0");
    }
    expect(vision.choose).not.toHaveBeenCalled();
  });
  it("uses vision after a low-confidence repeated group is narrowed without evidence", async () => {
    const { page, vision } = setup();
    let calls = 0;
    const jev = resolver((options) =>
      ++calls === 1
        ? answer(options, "r0", { r0: 0.5, r1: 0.4, none: 0.1 }, 0.1)
        : answer(options, "r0"),
    );
    const result = await resolveTarget(page, jev, {
      operation: "click",
      sentence: "click the right Edit",
      visionResolver: vision,
    });
    expect(calls).toBe(2);
    expect(result.kind === "resolved" && result.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
    expect(vision.choose).toHaveBeenCalledTimes(1);
  });
  it("accepts the second visual candidate, keeps Jev calls and never seeds the cache", async () => {
    const { page, vision, jev } = setup();
    const cache: CacheStore = {
      key: new Uint8Array(32).fill(9),
      lookup: async () => ({ reason: "absent" }),
      put: vi.fn(),
      invalidate: vi.fn(),
      clear: vi.fn(),
    };
    const result = await resolveTarget(page, jev, {
      operation: "click",
      sentence: "click the right Edit",
      visionResolver: vision,
      cache,
    });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("not resolved");
    expect(result.target.driverTarget().ref).toBe("fresh-r1");
    expect(result.cacheSeed).toBeUndefined();
    expect(result.calls).toHaveLength(2);
    expect(result.diagnostic.gate).toBe(
      "repeated_member_no_evidence:vision_selected",
    );
    expect(vision.choose).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "abstain", "error", "stale"])(
    "fails closed without retry after %s",
    async (mode) => {
      const { page, setVersion, vision, jev } = setup();
      vi.mocked(vision.choose).mockImplementation(async () => {
        if (mode === "error") throw new Error("provider failed");
        if (mode === "stale") setVersion({ ...initial, revision: 2 });
        return {
          decision:
            mode === "abstain"
              ? { kind: "abstain", reason: "ambiguous" }
              : { kind: "candidate", id: mode === "unknown" ? "C99" : "C2" },
          call,
        };
      });
      const result = await resolveTarget(page, jev, {
        operation: "click",
        sentence: "click the right Edit",
        visionResolver: vision,
      });
      expect(result).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
      if (mode === "stale")
        expect(result.diagnostic.vision).toMatchObject({
          outcome: "failed",
          failure: "stale_page",
        });
      expect(vision.choose).toHaveBeenCalledTimes(1);
    },
  );
  it("never invokes vision for fills", async () => {
    const { page, vision, jev } = setup();
    await resolveTarget(page, jev, {
      operation: "fill",
      sentence: "Edit",
      visionResolver: vision,
    });
    expect(vision.choose).not.toHaveBeenCalled();
  });
  it("asks vision when the text model finds no match for a click", async () => {
    const { page, vision } = setup();
    const none = resolver((options) => answer(options, "none"));
    const picked = await resolveTarget(page, none, {
      operation: "click",
      sentence: "click the Edit under the photo of the grey two-tone top",
      visionResolver: vision,
    });
    expect(vision.choose).toHaveBeenCalledTimes(1);
    expect(picked).toMatchObject({
      kind: "resolved",
      diagnostic: {
        gate: "none:vision_selected",
        vision: { outcome: "selected" },
      },
    });
    expect(picked.kind === "resolved" && picked.target.driverTarget().ref).toBe(
      "fresh-r1",
    );
    // A vision abstention keeps the text model's "none".
    vi.mocked(vision.choose).mockResolvedValueOnce({
      decision: { kind: "abstain" as const, reason: "no visible match" },
      call,
    });
    const abstained = await resolveTarget(recordedPage(items).page, none, {
      operation: "click",
      sentence: "click the Edit under the photo of the grey two-tone top",
      visionResolver: vision,
    });
    expect(abstained).toMatchObject({
      kind: "unresolved",
      reason: "none",
      diagnostic: {
        vision: {
          outcome: "abstained",
          reason: "none",
          abstentionReason: "no visible match",
        },
      },
    });
    // Without vision, "none" is unchanged.
    expect(
      await resolveTarget(recordedPage(items).page, none, {
        operation: "click",
        sentence: "click the Edit under the photo of the grey two-tone top",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "none" });
  });
  it("preserves safe vision failure details and billed usage", async () => {
    const { page, vision, jev } = setup();
    vi.mocked(vision.choose).mockRejectedValue(
      new VisionRequestError(
        "invalid-response",
        "truncated_response",
        1234,
        call,
        200,
      ),
    );
    const result = await resolveTarget(page, jev, {
      operation: "click",
      sentence: "click the right Edit",
      visionResolver: vision,
    });
    expect(result).toMatchObject({
      kind: "unresolved",
      reason: "ambiguous",
      diagnostic: {
        gate: "repeated_member_no_evidence:vision_error",
        vision: {
          failure: "truncated_response",
          elapsedMs: 1234,
          httpStatus: 200,
        },
      },
      calls: [call, call],
    });
    expect(vision.choose).toHaveBeenCalledTimes(1);
  });
  it("does not capture or call vision for confident unique targets", async () => {
    const { vision } = setup();
    vi.mocked(captureVisionObservation).mockClear();
    const result = await resolveTarget(
      recordedPage([candidate(0)]).page,
      resolver((options) => answer(options, "r0")),
      { operation: "click", sentence: "Item 0", visionResolver: vision },
    );
    expect(result.kind).toBe("resolved");
    expect(captureVisionObservation).not.toHaveBeenCalled();
    expect(vision.choose).not.toHaveBeenCalled();
  });
});
