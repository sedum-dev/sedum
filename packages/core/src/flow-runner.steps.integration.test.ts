import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import type {
  Judge,
  JudgeDecision,
  JudgePageDigest,
  ProviderCall,
  Resolver,
  ResolverCandidates,
  ResolverDecision,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import { RunRecorder } from "./run-recorder.js";

const call: ProviderCall = {
  requestedModel: "fake",
  model: "fake",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

/** Picks the candidate whose name the sentence contains, longest first. */
function choose(
  sentence: string,
  offered: ResolverCandidates,
): Promise<ResolverDecision> {
  const candidates = offered.options.flatMap((option) =>
    option.kind === "candidate" ? [option.candidate] : [],
  );
  const picked = [...candidates]
    .sort((a, b) => b.name.length - a.name.length)
    .find((candidate) =>
      sentence.toLowerCase().includes(candidate.name.toLowerCase()),
    );
  const ids = [...candidates.map((candidate) => candidate.id), "none"];
  const selected = picked?.id ?? "none";
  return Promise.resolve({
    selection:
      selected === "none"
        ? { kind: "none" }
        : { kind: "candidate", id: selected },
    probabilities: Object.fromEntries(
      ids.map((id) => [id, id === selected ? 0.95 : 0.05 / (ids.length - 1)]),
    ),
    confidence: null,
    call,
  });
}

/** `the text X is shown` holds when the judged page text contains X. */
function holds(claim: string, digest: JudgePageDigest): Promise<JudgeDecision> {
  const match = /(?:text\s+(.+?)\s+is\s+shown|shows\s+(.+))$/u.exec(claim);
  const fragment = match?.[1] ?? match?.[2] ?? claim;
  const found = digest.text.includes(fragment);
  return Promise.resolve({
    holds: found ? 0.97 : 0.03,
    contradicted: found ? 0.01 : 0.9,
    call,
  });
}

// Text and a button that turn up late, a page that never changes, and a
// redirect a moment after load.
const PAGES: Record<string, string> = {
  "/late": `<main><p>Loading</p><a href="/static">Help</a><div id="slot"></div><script>
    setTimeout(() => { document.querySelector("#slot").innerHTML = '<button onclick="location.href=\\'/done\\'">Continue</button>'; }, 2000);
    setTimeout(() => { document.querySelector("p").textContent = "Ready"; }, 1500);
  </script></main>`,
  "/static": "<main><p>Nothing changes here</p></main>",
  "/redirect": `<main><p>Redirecting</p><script>setTimeout(() => { location.href = "/done"; }, 600);</script></main>`,
  "/done": "<main><h1>All done</h1></main>",
  "/semantic": "<main><button>Add account</button></main>",
  "/list": `<main><h1>Accounts</h1><ul><li>SeedBank £1</li><li>NewBank £2</li></ul>
    <p>Total £3</p><button>Add account</button>
    <aside inert style="position:fixed;left:-9999px">Ask Pennee SecretBank</aside>
    <p>${"Long filler text. ".repeat(400)}</p></main>`,
  "/form": `<main>
    <label>Name <input id="name"></label>
    <label>Email <input readonly value="ada@example.com"></label>
    <label>Password <input type="password" value="hunter2"></label>
    <label><input type="checkbox"> Remember me</label>
    <button aria-label="Search"><i class="fa-search"></i></button>
    <div role="button" id="save" aria-disabled="true">Save</div>
    <script>document.querySelector("#name").addEventListener("input", (event) => {
      document.querySelector("#save").setAttribute("aria-disabled", String(!event.target.value));
    });</script></main>`,
};

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "steps that wait for the page",
  () => {
    let server: Server;
    let base = "";
    let root = "";
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "sedum-steps-"));
      server = createServer((request, response) => {
        const page = PAGES[new URL(request.url ?? "/", "http://x").pathname];
        response.writeHead(page ? 200 : 404, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          page ? `<!doctype html><html><body>${page}</body></html>` : "missing",
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture port missing");
      base = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    let counter = 0;
    async function run(
      url: string,
      steps: readonly string[],
      verifyGraceMs = 0,
      signal?: AbortSignal,
      overrides: { holds?: Judge["holds"]; choose?: Resolver["choose"] } = {},
      data: Record<string, string> = {},
    ) {
      const file = path.join(root, `flow-${++counter}.test.yaml`);
      const values = Object.entries(data)
        .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`)
        .join("");
      await writeFile(
        file,
        `url: ${base}${url}\n${values ? `data:\n${values}` : ""}steps:\n${steps.map((step) => `  - ${JSON.stringify(step)}`).join("\n")}\n`,
      );
      const judge = vi.fn(overrides.holds ?? holds);
      const resolver = vi.fn(overrides.choose ?? choose);
      const recorder = new RunRecorder(async () => undefined, `run-${counter}`);
      await recorder.start();
      const started = performance.now();
      const flow = await runFlow(file, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        browserKind: "chromium",
        classificationCache: new NoopClassificationCache(),
        provider: { classifyBatch: vi.fn(), choose: resolver, holds: judge },
        env: {},
        verifyGraceMs,
        ...(signal ? { signal } : {}),
        report: {
          recorder,
          privacy: { secretValues: [], sensitiveOrigins: [] },
          evidenceEnabled: false,
          replay: false,
          saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
        },
      });
      const elapsedMs = performance.now() - started;
      await recorder.finish(
        flow.status === "could_not_run"
          ? { code: flow.code, message: flow.message }
          : null,
      );
      const steps_ = recorder.snapshot.tests[0]?.attempts[0]?.steps ?? [];
      return { flow, steps: steps_, judge, resolver, elapsedMs };
    }

    it("waits until a claim holds, judging again as the page changes", async () => {
      const outcome = await run("/late", [
        "wait up to 6 seconds until the page shows Ready",
      ]);
      expect(outcome.flow.status, JSON.stringify(outcome.flow)).toBe("passed");
      expect(outcome.judge.mock.calls.length).toBeGreaterThan(1);
      // Earlier judgements are billed on the step, not dropped.
      expect(outcome.steps[0]!.calls.length).toBe(
        outcome.judge.mock.calls.length,
      );
    }, 30_000);

    it("fails a wait at its limit with the last judgement", async () => {
      const outcome = await run("/static", [
        "wait up to 2 seconds until the page shows Ready",
      ]);
      expect(outcome.flow.status).toBe("failed");
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1_900);
      expect(outcome.steps[0]).toMatchObject({
        verdict: "failed",
        judgement: { holds: 0.03 },
      });
    }, 30_000);

    it("waits through a navigation", async () => {
      const outcome = await run("/redirect", [
        "wait up to 6 seconds until the page shows All done",
      ]);
      expect(outcome.flow.status, JSON.stringify(outcome.flow)).toBe("passed");
    }, 30_000);

    it("gives a failing verify a grace while the page changes", async () => {
      const graced = await run("/late", ["verify the page shows Ready"], 4_000);
      expect(graced.flow.status, JSON.stringify(graced.flow)).toBe("passed");
      const once = await run("/late", ["verify the page shows Ready"], 0);
      expect(once.flow.status).toBe("failed");
      expect(once.judge).toHaveBeenCalledTimes(1);
    }, 30_000);

    it("does not judge a page that stays put again", async () => {
      const outcome = await run(
        "/static",
        ["verify the page shows Ready"],
        1_500,
      );
      expect(outcome.flow.status).toBe("failed");
      expect(outcome.judge).toHaveBeenCalledTimes(1);
    }, 30_000);

    it("stops a wait when the run is canceled and keeps billed judgements", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const outcome = await run(
        "/static",
        ["wait up to 6 seconds until the page shows Ready"],
        0,
        controller.signal,
      );
      clearTimeout(timer);
      expect(outcome.flow.status).toBe("could_not_run");
      expect(outcome.elapsedMs).toBeLessThan(2_000);
      expect(outcome.steps[0]).toMatchObject({
        state: "error",
        error: { code: "canceled" },
      });
      expect(outcome.steps[0]!.calls.length).toBe(
        outcome.judge.mock.calls.length,
      );
    }, 30_000);

    it("bounds an in-flight judgement by the wait deadline", async () => {
      const outcome = await run(
        "/static",
        ["wait up to 1 second until the page shows Ready"],
        0,
        undefined,
        {
          holds: async (_claim, _digest, options) =>
            await new Promise<JudgeDecision>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(new ProviderError("timeout", "deadline", 1, call)),
                { once: true },
              );
            }),
        },
      );
      expect(outcome.elapsedMs).toBeLessThan(2_000);
      expect(outcome.flow.status).toBe("could_not_run");
      expect(outcome.steps[0]).toMatchObject({
        state: "error",
        error: { code: "observation_timeout" },
      });
      expect(outcome.steps[0]!.calls).toHaveLength(1);
    }, 30_000);

    it("keeps earlier judgement receipts when a retry hits a run-wide error", async () => {
      let attempts = 0;
      const outcome = await run(
        "/late",
        ["wait up to 6 seconds until the page shows Ready"],
        0,
        undefined,
        {
          holds: async () => {
            attempts++;
            if (attempts === 1) return { holds: 0.03, contradicted: 0.9, call };
            throw new ProviderError("authentication", "bad key", 1);
          },
        },
      );
      expect(outcome.flow.status).toBe("could_not_run");
      expect(outcome.steps[0]!.calls).toHaveLength(2);
      expect(outcome.steps[0]!.calls[1]?.costUsd).toBeNull();
    }, 30_000);

    it("keeps earlier locator receipts when auto-wait hits a run-wide error", async () => {
      let attempts = 0;
      const outcome = await run(
        "/late",
        ["click the Continue button"],
        4_000,
        undefined,
        {
          choose: async (...args) => {
            attempts++;
            if (attempts === 1) return choose(args[0], args[1]);
            throw new ProviderError("authentication", "bad key", 1);
          },
        },
      );
      expect(outcome.flow.status).toBe("could_not_run");
      expect(outcome.steps[0]!.calls).toHaveLength(2);
      expect(outcome.steps[0]!.calls[1]?.costUsd).toBeNull();
    }, 30_000);

    it("stops target auto-wait when the run is canceled", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const outcome = await run(
        "/late",
        ["click the Continue button"],
        4_000,
        controller.signal,
      );
      clearTimeout(timer);
      expect(outcome.flow.status).toBe("could_not_run");
      expect(outcome.elapsedMs).toBeLessThan(2_000);
      expect(outcome.steps[0]).toMatchObject({
        state: "error",
        error: { code: "canceled" },
      });
      expect(outcome.steps[0]!.calls.length).toBe(
        outcome.resolver.mock.calls.length,
      );
    }, 30_000);

    it("waits for a click target to appear within the grace", async () => {
      const graced = await run(
        "/late",
        ["click the Continue button", "verify the text All done is shown"],
        4_000,
      );
      expect(graced.flow.status, JSON.stringify(graced.flow)).toBe("passed");
      const once = await run("/late", ["click the Continue button"], 0);
      expect(once.flow.status).toBe("failed");
      expect(once.steps[0]?.error?.code).toBe("no_match");
    }, 30_000);

    it("waits through a near-tie with no match without clicking the old screen", async () => {
      let first = true;
      const outcome = await run(
        "/late",
        ["click the Continue button"],
        4_000,
        undefined,
        {
          choose: async (sentence, offered) => {
            if (!first) return choose(sentence, offered);
            first = false;
            const old = offered.options.find(
              (option) => option.kind === "candidate",
            );
            if (!old || old.kind !== "candidate")
              throw new Error("Missing old screen");
            return {
              selection: { kind: "candidate", id: old.candidate.id },
              probabilities: { [old.candidate.id]: 0.51, none: 0.49 },
              confidence: null,
              call,
            };
          },
        },
      );
      expect(outcome.flow.status, JSON.stringify(outcome.flow)).toBe("passed");
      expect(outcome.resolver.mock.calls.length).toBeGreaterThan(1);
      expect(outcome.steps[0]!.calls.length).toBe(
        outcome.resolver.mock.calls.length,
      );
    }, 30_000);

    it("checks a control's state on the control", async () => {
      const outcome = await run(
        "/form",
        [
          "verify the Save button is disabled",
          "type {{name}} in the Name field",
          "verify the Save button is enabled",
          "click the Remember me checkbox",
          "verify the Remember me checkbox is checked",
          "verify the Search button is shown",
        ],
        0,
        undefined,
        undefined,
        { name: "Ada" },
      );
      expect(outcome.flow.status, JSON.stringify(outcome.flow)).toBe("passed");
      // State is read on the page, never judged.
      expect(outcome.judge).not.toHaveBeenCalled();
    }, 30_000);

    it("compares a field's value without showing it to the model", async () => {
      const passing = await run(
        "/form",
        ["verify the Email field contains {{email}}"],
        0,
        undefined,
        undefined,
        { email: "ada@example.com" },
      );
      expect(passing.flow.status, JSON.stringify(passing.flow)).toBe("passed");
      const failing = await run(
        "/form",
        ["verify the Email field contains {{email}}"],
        0,
        undefined,
        undefined,
        { email: "grace@example.com" },
      );
      expect(failing.flow.status).toBe("failed");
      expect(failing.steps[0]?.error).toMatchObject({
        code: "element_state",
        message: "The field holds a different value.",
      });
      for (const outcome of [passing, failing]) {
        expect(JSON.stringify(outcome.resolver.mock.calls)).not.toMatch(
          /ada@example|grace@example/u,
        );
        expect(outcome.judge).not.toHaveBeenCalled();
      }
    }, 30_000);

    it("checks quoted text, counts, and the URL exactly", async () => {
      const outcome = await run(
        "/list",
        [
          'verify "{{bank}}" appears once',
          'verify "Bank" appears exactly 2 times',
          'verify the text "Add account" is shown',
          'verify the text "DeletedBank" is not shown',
          'verify the text "Missing" or "Total £3" is shown',
          'verify the page URL contains "/list"',
          // Text in an inert panel off screen is not readable.
          'verify the text "SecretBank" is not shown',
        ],
        0,
        undefined,
        undefined,
        { bank: "SeedBank" },
      );
      expect(
        outcome.flow.status,
        JSON.stringify(
          outcome.steps.map((step) => [step.sentence, step.error]),
        ),
      ).toBe("passed");
      expect(outcome.judge).not.toHaveBeenCalled();
    }, 30_000);

    it("fails an exact check with what the page shows", async () => {
      const outcome = await run("/list", ['verify "Bank" appears once']);
      expect(outcome.flow.status).toBe("failed");
      expect(outcome.steps[0]?.error).toMatchObject({
        code: "text_check",
        message: "The text appears 2 times on the page.",
      });
    }, 30_000);

    it("passes a literal on the page without the Judge, even past its size limit", async () => {
      // The page is too long for the Judge, so only the literal path works.
      const outcome = await run("/list", ["verify the text total £3 is shown"]);
      expect(outcome.flow.status, JSON.stringify(outcome.flow)).toBe("passed");
      expect(outcome.judge).not.toHaveBeenCalled();
    }, 30_000);

    it("cannot judge a missing literal on a page too long for the Judge", async () => {
      const outcome = await run("/list", [
        "verify the text Overdraft is shown",
      ]);
      expect(outcome.flow.status).toBe("could_not_run");
      expect(outcome.steps[0]?.error?.code).toBe("oversize_digest");
    }, 30_000);

    it("does not satisfy a heading claim with matching button text", async () => {
      const outcome = await run("/semantic", [
        "verify the heading Add account is shown",
      ]);
      expect(outcome.flow.status).toBe("failed");
      expect(outcome.judge).toHaveBeenCalledOnce();
    }, 30_000);

    it("does not infer emptiness from an unreadable password", async () => {
      for (const claim of [
        "verify the Password field is empty",
        "verify the Password field is not empty",
      ]) {
        const outcome = await run("/form", [claim]);
        expect(outcome.flow.status).toBe("failed");
        expect(outcome.steps[0]?.error).toMatchObject({
          code: "element_state",
          message: "The control holds no readable value.",
        });
        expect(outcome.judge).not.toHaveBeenCalled();
      }
    }, 30_000);
  },
);
