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
      sentence: "Add Camera to cart",
    });
    expect(clear.kind).toBe("resolved");
    expect(clear.calls).toHaveLength(2);
    const vague = await resolveTarget(page, model, {
      operation: "click",
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
          sentence: "Add Camera to cart",
        })
      ).kind,
    ).toBe("resolved");
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
    const vague = { operation: "click" as const, sentence: "click Pricing" };
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
          sentence: "Add to cart for Product Camera",
        })
      ).kind,
    ).toBe("resolved");
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
    ];
    const { page } = recordedPage(items);
    const model = resolver((options) =>
      answer(options, "r0", { r0: 0.9, r1: 0.05, none: 0.05 }, 0.95),
    );
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        sentence: "the comments link for the first story in the list",
      }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        sentence: "the comments link for the first ranked story",
      }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      await resolveTarget(page, model, {
        operation: "click",
        sentence: "the comments link",
      }),
    ).toMatchObject({ kind: "unresolved", reason: "ambiguous" });
    expect(
      await resolveTarget(page, model, {
        operation: "click",
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

  it("requires local evidence for explicit article and first-story regions", async () => {
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
    expect(
      await resolveTarget(page, wrong, {
        operation: "click",
        sentence: "comments for the first story",
      }),
    ).toMatchObject({
      kind: "unresolved",
      reason: "ambiguous",
      diagnostic: { gate: "explicit_region_unproven" },
    });
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
