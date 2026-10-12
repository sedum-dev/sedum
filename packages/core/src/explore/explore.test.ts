import { describe, expect, it } from "vitest";
import { actionTree, targetSignature, type Leaf } from "./actions.js";
import type { Observation } from "./observe.js";
import { targetVariants } from "./emit.js";
import { Coverage, guide } from "./guidance.js";
import { blindValue, heuristicGenerator, hostileText } from "./inputs.js";
import { looksDestructive } from "./kinds.js";
import { findByIdentity, identityOf, sameOriginHref } from "./observe.js";
import { endpoint, graphqlMutation, signature } from "./oracles.js";
import { hashText, pickWeighted, SeededRandom } from "./random.js";
import { DEFAULT_TUNING, type ExploreAdvice } from "./types.js";
import type { Candidate } from "../page-protocol.js";

function candidate(name: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    ref: `r-${name}`,
    tag: "button",
    role: "button",
    name,
    peers: [],
    editable: false,
    disabled: false,
    inputType: "",
    signals: { path: name },
    ...extra,
  };
}

function click(name: string, destination = `link /${name}`): Leaf {
  return {
    kind: "click",
    base: 50,
    identity: { role: "button", name, occurrence: 0 },
    destination,
  };
}

const call = {
  requestedModel: "jev-latest",
  model: "jev-1.13.0",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

describe("seeded random", () => {
  it("repeats a sequence for a seed and differs across seeds", () => {
    const draw = (seed: number) => {
      const random = new SeededRandom(seed);
      return Array.from({ length: 5 }, () => random.next());
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  it("never picks a zero weight", () => {
    const random = new SeededRandom(1);
    for (let i = 0; i < 200; i++)
      expect(pickWeighted(random, [0, 1, 0, 3])).not.toBe(0);
  });

  it("hashes text stably", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });
});

describe("inputs", () => {
  it("types plausible email and digits blindly, like Bombadil", () => {
    const random = new SeededRandom(3);
    expect(blindValue(random, "email")).toMatch(/^[a-z]+@[a-z]+\.test$/u);
    expect(blindValue(random, "number")).toMatch(/^\d+$/u);
  });

  it("produces hostile text and type-based generators", () => {
    expect(hostileText(new SeededRandom(2)).length).toBeGreaterThan(0);
    expect(heuristicGenerator("email", "Email")).toBe(
      "faker.internet.exampleEmail",
    );
    expect(heuristicGenerator("text", "ZIP code")).toBe(
      "faker.location.zipCode",
    );
  });
});

describe("boundary and identity", () => {
  it("keeps same-origin links and rejects others", () => {
    const base = "http://127.0.0.1:4000/explore/";
    expect(sameOriginHref("/explore/help", base)).toBe("/explore/help");
    expect(sameOriginHref("https://example.com/x", base)).toBeNull();
    expect(sameOriginHref("javascript:void(0)", base)).toBeNull();
    expect(sameOriginHref(undefined, base)).toBeUndefined();
  });

  it("finds a repeated target by its peer, then by occurrence", () => {
    const list = [
      candidate("Add", { peers: ["Mug"], ref: "a" }),
      candidate("Add", { peers: ["Socks"], ref: "b" }),
    ];
    const identity = identityOf(list, list[1]!, "http://x.test/");
    expect(identity.occurrence).toBe(1);
    const reordered = [list[1]!, list[0]!];
    expect(findByIdentity(reordered, identity)?.ref).toBe("b");
    expect(findByIdentity([], identity)).toBeNull();
  });
});

describe("guidance", () => {
  const tuning = { ...DEFAULT_TUNING, epsilon: 0 };

  it("leaves the blind walk unchanged", () => {
    const leaves = [
      click("a"),
      click("b"),
      { kind: "scroll", base: 5 } as Leaf,
    ];
    const guided = guide({
      mode: "random",
      leaves,
      coverage: new Coverage(),
      tuning,
    });
    expect(guided.probabilities).toEqual([50 / 105, 50 / 105, 5 / 105]);
  });

  it("skips destructive targets and down-weights uncertain ones", () => {
    const leaves = [click("Delete account"), click("Help"), click("Maybe")];
    const advice: ExploreAdvice = {
      kind: { choice: "account", probabilities: { account: 1 }, confidence: 1 },
      destructive: { t0: 0.9, t1: 0.02, t2: 0.4 },
      leadsTo: {},
      call,
    };
    const guided = guide({
      mode: "guided",
      leaves,
      coverage: new Coverage(),
      tuning,
      advice: {
        answer: advice,
        ids: new Map([
          [0, "t0"],
          [1, "t1"],
          [2, "t2"],
        ]),
      },
    });
    expect(guided.skipped).toEqual(["Delete account"]);
    expect(guided.probabilities[0]).toBe(0);
    expect(guided.probabilities[1]!).toBeGreaterThan(guided.probabilities[2]!);
  });

  it("keeps the blind share over safe leaves only", () => {
    const leaves = [click("Delete account"), click("Help")];
    const guided = guide({
      mode: "heuristic",
      leaves,
      coverage: new Coverage(),
      tuning: { ...DEFAULT_TUNING, epsilon: 0.5 },
    });
    expect(looksDestructive("Delete account")).toBe(true);
    expect(guided.probabilities).toEqual([0, 1]);
  });

  it("favours actions that lead to rarely seen page kinds", () => {
    const coverage = new Coverage();
    for (let i = 0; i < 9; i++) coverage.visit("detail");
    const leaves = [click("Item"), click("Admin")];
    const guided = guide({
      mode: "guided",
      leaves,
      coverage,
      tuning,
      advice: {
        answer: {
          kind: {
            choice: "listing",
            probabilities: { listing: 1 },
            confidence: 1,
          },
          destructive: { t0: 0, t1: 0 },
          leadsTo: { t0: { detail: 1, admin: 0 }, t1: { detail: 0, admin: 1 } },
          call,
        },
        ids: new Map([
          [0, "t0"],
          [1, "t1"],
        ]),
      },
    });
    expect(guided.why[1]?.expectedKind).toBe("admin");
    expect(guided.probabilities[1]!).toBeGreaterThan(
      5 * guided.probabilities[0]!,
    );
  });

  it("prefers observed destinations over predictions", () => {
    const coverage = new Coverage();
    coverage.visit("content");
    coverage.learn("link /a", "content");
    expect(coverage.expected("link /a", { admin: 1 })).toEqual({
      novelty: 1 / Math.sqrt(2),
      kind: "content",
    });
    expect(coverage.tried("link /a")).toBe(1);
  });
});

describe("action tree", () => {
  const observation: Observation = {
    url: "http://shop.test/signup",
    route: "/signup",
    title: "Sign up",
    text: "Sign up",
    version: { document: "d", revision: 1, route: "/signup" },
    clicks: [
      candidate("Help", {
        role: "link",
        signals: { path: "a", href: "/help" },
      }),
      candidate("Elsewhere", {
        role: "link",
        signals: { path: "b", href: "https://other.test/" },
      }),
    ],
    fills: [
      candidate("Email", {
        role: "textbox",
        editable: true,
        inputType: "email",
      }),
    ],
    state: "s",
  };

  it("drops links that leave the origin and offers the form fill on form pages", () => {
    const plain = actionTree({
      observation,
      canGoBack: false,
      excluded: new Set(),
    });
    expect(
      plain.filter((l) => l.kind === "click").map((l) => l.identity?.name),
    ).toEqual(["Help"]);
    expect(plain.some((l) => l.kind === "form")).toBe(false);
    const form = actionTree({
      observation,
      canGoBack: true,
      formPage: true,
      excluded: new Set(["back"]),
    });
    expect(form.find((l) => l.kind === "form")?.destination).toBe(
      "/signup form",
    );
    expect(form.some((l) => l.kind === "back")).toBe(false);
  });
});

describe("learned from a real staging run", () => {
  const advice = (p: number): ExploreAdvice => ({
    kind: { choice: "listing", probabilities: { listing: 1 }, confidence: 1 },
    destructive: { t0: p, t1: 0.02 },
    leadsTo: {},
    call,
  });
  const ids = new Map([
    [0, "t0"],
    [1, "t1"],
  ]);

  it("strict safety skips a keyword match that Jev scored low", () => {
    const leaves = [click("Log out"), click("Clients")];
    const run = (strictSafety: boolean) =>
      guide({
        mode: "guided",
        leaves,
        coverage: new Coverage(),
        tuning: { ...DEFAULT_TUNING, strictSafety },
        advice: { answer: advice(0.16), ids },
      });
    expect(run(false).skipped).toEqual([]);
    expect(run(true).skipped).toEqual(["Log out"]);
  });

  it("shares one destination for chrome seen on several routes", () => {
    const nav = candidate("Clients", { role: "" });
    const observation = {
      url: "http://app.test/a",
      route: "/a",
      title: "",
      text: "",
      version: { document: "d", revision: 1, route: "/a" },
      clicks: [nav],
      fills: [],
      state: "s",
    };
    const plain = actionTree({
      observation,
      canGoBack: false,
      excluded: new Set(),
    });
    const global = actionTree({
      observation,
      canGoBack: false,
      excluded: new Set(),
      globalTargets: new Set([targetSignature(nav)]),
    });
    expect(plain[0]?.destination).toBe("/a  Clients#0");
    expect(global[0]?.destination).toBe("global |Clients|#0");
  });
});

describe("emitted sentences", () => {
  it("names the target, then adds its item or section", () => {
    expect(
      targetVariants(
        {
          role: "button",
          name: "Add to cart",
          peer: "Camp Mug",
          location: "main · Products",
          occurrence: 1,
        },
        false,
      ),
    ).toEqual([
      'the "Add to cart" button',
      'the "Add to cart" button for Camp Mug',
      'the "Add to cart" button in the Products section',
    ]);
    expect(
      targetVariants(
        { role: "searchbox", name: "Search", occurrence: 0 },
        true,
      ),
    ).toEqual(['the "Search" field']);
  });
});

describe("write log", () => {
  it("counts GraphQL mutations, not queries", () => {
    const url = new URL("https://app.test/practice/graphql");
    expect(
      graphqlMutation(url, JSON.stringify({ query: "query Clients { a }" })),
    ).toBeNull();
    expect(
      graphqlMutation(
        url,
        JSON.stringify([
          { query: "mutation MarkRead { a }", operationName: "MarkRead" },
        ]),
      ),
    ).toBe("MarkRead");
    expect(graphqlMutation(new URL("https://app.test/api/users"), "{}")).toBe(
      "",
    );
  });

  it("halves a target's weight after each failure", () => {
    const coverage = new Coverage();
    const view = candidate("View");
    coverage.fail(view);
    coverage.fail(view);
    expect(coverage.reliability(view)).toBe(0.25);
    expect(coverage.reliability(candidate("Edit"))).toBe(1);
  });
});

describe("oracle signatures", () => {
  it("names an endpoint once, whatever record it was for", () => {
    expect(endpoint("/api/articles/how-to-learn-js-2/comments")).toBe(
      "/api/articles/:id/comments",
    );
    expect(endpoint("/api/articles")).toBe("/api/articles");
  });

  it("ignores numbers, origins and stacks", () => {
    const origin = "http://127.0.0.1:4519";
    expect(signature(`HTTP 500 GET ${origin}/api/7`, origin)).toBe(
      "HTTP # GET /api/#",
    );
    expect(signature("TypeError: x\n    at f (a.js:1:2)", origin)).toBe(
      "TypeError: x",
    );
  });
});
