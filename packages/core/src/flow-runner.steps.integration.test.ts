import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import type {
  JudgeDecision,
  JudgePageDigest,
  ProviderCall,
  ResolverCandidates,
  ResolverDecision,
} from "./provider.js";
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
  "/form": `<main>
    <label>Name <input id="name"></label>
    <label>Email <input readonly value="ada@example.com"></label>
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
      const judge = vi.fn(holds);
      const resolver = vi.fn(choose);
      const recorder = new RunRecorder(async () => undefined, `run-${counter}`);
      await recorder.start();
      const started = performance.now();
      const flow = await runFlow(file, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        classificationCache: new NoopClassificationCache(),
        provider: { classifyBatch: vi.fn(), choose: resolver, holds: judge },
        env: {},
        verifyGraceMs,
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
          // The Search icon button is no field.
          "verify the Search field is not shown",
        ],
        0,
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
        { email: "ada@example.com" },
      );
      expect(passing.flow.status, JSON.stringify(passing.flow)).toBe("passed");
      const failing = await run(
        "/form",
        ["verify the Email field contains {{email}}"],
        0,
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
  },
);
