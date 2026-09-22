import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "./browser-driver.js";
import type { DigestResult, PageVersion } from "./page-protocol.js";
import type { Judge, ProviderCall } from "./provider.js";
import {
  AssertionEngineError,
  evaluateVerifyScores,
  measure,
  verify,
} from "./assertion-engine.js";

const firstVersion: PageVersion = {
  document: "one",
  revision: 1,
  route: "https://example.test/?private=route-secret",
};
const nextVersion: PageVersion = {
  document: "one",
  revision: 2,
  route: "https://example.test/next?private=route-secret",
};
const call: ProviderCall = {
  requestedModel: "jev-latest",
  model: "jev-1.13.0",
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 2 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};

function fakePage(text = "The products page shows six items.") {
  let current = firstVersion;
  let quietVersion = firstVersion;
  let digest: DigestResult = {
    protocol: 1,
    version: firstVersion,
    text,
    complete: true,
  };
  let digestReads = 0;
  let digestErrors = 0;
  let versionErrors = 0;
  let onDigest: (() => void) | undefined;
  const settle = vi.fn(async () => ({ settled: true, elapsedMs: 1 }));
  const evaluate = vi.fn(async (expression: string) => {
    let value: unknown;
    if (expression.includes('bridge["quiet"]'))
      value = { quiet: true, version: quietVersion };
    else if (expression.includes('bridge["digest"]')) {
      if (digestErrors > 0) {
        digestErrors--;
        throw new Error("Execution context was destroyed during navigation");
      }
      digestReads++;
      value = digest;
      onDigest?.();
    } else if (expression.includes('bridge["pageVersion"]')) {
      if (versionErrors > 0) {
        versionErrors--;
        throw new Error("Browser read failed at route-secret");
      }
      value = current;
    }
    return { installed: true, protocol: 1, value };
  });
  return {
    page: { settle, evaluate } as unknown as BrowserPage,
    settle,
    evaluate,
    get digestReads() {
      return digestReads;
    },
    setDigest(next: DigestResult) {
      digest = next;
    },
    setVersion(next: PageVersion) {
      current = next;
    },
    setQuietVersion(next: PageVersion) {
      quietVersion = next;
    },
    onDigest(callback: () => void) {
      onDigest = callback;
    },
    failNextDigestReads(count: number) {
      digestErrors = count;
    },
    failNextVersionReads(count: number) {
      versionErrors = count;
    },
  };
}

function fakeJudge(holds = 0.9, contradicted = 0.1) {
  const response = { holds, contradicted, call };
  const judge = {
    holds: vi.fn(async () => response),
  } as unknown as Judge;
  return { judge, holds: judge.holds as ReturnType<typeof vi.fn> };
}

describe("SED-13 verify policy", () => {
  it.each([
    [0.75, 0.499999, "passed", []],
    [0.75, 0.5, "passed", ["contradiction"]],
    [0.6, 0.1, "passed", ["low_confidence"]],
    [0.6, 0.5, "passed", ["low_confidence", "contradiction"]],
    [0.599999, 1, "failed", []],
  ] as const)(
    "maps holds=%s contradicted=%s to %s and %j",
    (holds, contradicted, verdict, flags) => {
      expect(evaluateVerifyScores(holds, contradicted)).toEqual({
        verdict,
        flags,
        minP: 0.75,
        band: 0.15,
        contradictionCutoff: 0.5,
      });
    },
  );

  it("uses exact boundary values and effective policy", () => {
    expect(evaluateVerifyScores(0, 1, { minP: 0 })).toMatchObject({
      verdict: "passed",
      flags: ["contradiction"],
      minP: 0,
    });
    expect(evaluateVerifyScores(1, 0, { minP: 1 })).toMatchObject({
      verdict: "passed",
      flags: [],
      minP: 1,
    });
    expect(
      evaluateVerifyScores(0.8, 0.2, {
        minP: 0.9,
        band: 0.1,
        contradictionCutoff: 0.2,
      }),
    ).toMatchObject({
      verdict: "passed",
      flags: ["low_confidence", "contradiction"],
      minP: 0.9,
      band: 0.1,
      contradictionCutoff: 0.2,
    });
  });

  it.each([NaN, Infinity, -Infinity, -0.1, 1.1])(
    "rejects invalid scores and policy values: %s",
    (value) => {
      expect(() => evaluateVerifyScores(value, 0)).toThrow(RangeError);
      expect(() => evaluateVerifyScores(0, value)).toThrow(RangeError);
      expect(() => evaluateVerifyScores(0, 0, { minP: value })).toThrow(
        RangeError,
      );
      expect(() => evaluateVerifyScores(0, 0, { band: value })).toThrow(
        RangeError,
      );
      expect(() =>
        evaluateVerifyScores(0, 0, { contradictionCutoff: value }),
      ).toThrow(RangeError);
    },
  );
});

describe("assertion engine", () => {
  it("uses one complete judged digest and omits clean-pass evidence", async () => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    const result = await verify(page.page, judge, "There are six products.");
    expect(page.settle).toHaveBeenCalledWith({
      state: "domcontentloaded",
      timeoutMs: 4_000,
    });
    expect(holds).toHaveBeenCalledOnce();
    expect(holds).toHaveBeenCalledWith(
      "There are six products.",
      { complete: true, text: "The products page shows six items." },
      {},
    );
    expect(result).toMatchObject({
      kind: "verify",
      verdict: "passed",
      flags: [],
      holds: 0.9,
      contradicted: 0.1,
      call,
      minP: 0.75,
      band: 0.15,
      contradictionCutoff: 0.5,
    });
    expect(result).not.toHaveProperty("judgedExcerpt");
    expect(JSON.stringify(result)).not.toContain("route-secret");
  });

  it("retains bounded exact judged evidence on flags, failures and measures", async () => {
    const text = "🧪".repeat(1_600);
    const page = fakePage(text);
    const flagged = await verify(page.page, fakeJudge(0.6, 0.5).judge, "Claim");
    expect(flagged).toMatchObject({
      verdict: "passed",
      flags: ["low_confidence", "contradiction"],
    });
    expect(Array.from(flagged.judgedExcerpt ?? "")).toHaveLength(1_500);
    expect(flagged.judgedExcerpt).toContain("…[truncated]");
    const failed = await verify(page.page, fakeJudge(0.2, 0.9).judge, "Claim");
    expect(failed).toMatchObject({ verdict: "failed", flags: [] });
    expect(failed.judgedExcerpt).toBe(flagged.judgedExcerpt);
    const observed = await measure(
      page.page,
      fakeJudge(0.2, 0.9).judge,
      "Claim",
    );
    expect(observed).toMatchObject({
      kind: "measure",
      holds: 0.2,
      contradicted: 0.9,
    });
    expect(observed).not.toHaveProperty("verdict");
    expect(observed).not.toHaveProperty("flags");
    expect(observed.judgedExcerpt).toBe(flagged.judgedExcerpt);
  });

  it("rejects malformed inputs before touching the page or Judge", async () => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    await expect(verify(page.page, judge, "  ")).rejects.toThrow(TypeError);
    await expect(
      verify(page.page, judge, "Claim", { minP: NaN }),
    ).rejects.toThrow(RangeError);
    await expect(
      measure(page.page, judge, "Claim", { observationTimeoutMs: 0 }),
    ).rejects.toThrow(RangeError);
    expect(page.settle).not.toHaveBeenCalled();
    expect(holds).not.toHaveBeenCalled();
  });

  it.each([
    ["digest_too_large", "oversize_digest"],
    ["scope_ambiguous", "ambiguous_digest"],
    ["resource_ceiling", "incomplete_digest"],
  ] as const)("fails closed on %s", async (error, code) => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    page.setDigest({
      protocol: 1,
      version: firstVersion,
      text: "",
      complete: false,
      error,
    });
    await expect(verify(page.page, judge, "Claim")).rejects.toMatchObject({
      code,
    });
    expect(holds).not.toHaveBeenCalled();
  });

  it("rejects a Wikipedia-shaped over-limit digest before transmission", async () => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    page.setDigest({
      protocol: 1,
      version: firstVersion,
      text: "Ada Lovelace ".repeat(6_000),
      complete: true,
    });
    await expect(
      verify(page.page, judge, "Ada wrote an algorithm."),
    ).rejects.toMatchObject({
      code: "oversize_digest",
    });
    expect(holds).not.toHaveBeenCalled();
  });

  it("keeps missing page scripts and browser read failures operational", async () => {
    const missing = fakePage();
    missing.evaluate.mockResolvedValueOnce({
      installed: false,
      protocol: 1,
      value: undefined,
    });
    const { judge, holds } = fakeJudge();
    await expect(verify(missing.page, judge, "Claim")).rejects.toMatchObject({
      code: "missing_digest",
    });
    expect(holds).not.toHaveBeenCalled();

    const browser = fakePage();
    browser.evaluate.mockRejectedValueOnce(
      new Error("Browser read failed at route-secret"),
    );
    const result = await verify(browser.page, judge, "Claim").catch(
      (error: unknown) => error,
    );
    if (!(result instanceof AssertionEngineError))
      throw new Error("Expected an operational error");
    expect(result).toMatchObject({ code: "browser_failure" });
    expect(result.cause).toBeUndefined();
    expect(inspect(result)).not.toContain("route-secret");
    expect(JSON.stringify(result)).not.toContain("route-secret");
    expect(holds).not.toHaveBeenCalled();
  });

  it("re-reads after an empty or raced observation", async () => {
    const page = fakePage("");
    const { judge, holds } = fakeJudge();
    page.onDigest(() => {
      if (page.digestReads === 1)
        page.setDigest({
          protocol: 1,
          version: firstVersion,
          text: "Late content",
          complete: true,
        });
    });
    const result = await verify(page.page, judge, "Late content appears.");
    expect(result.verdict).toBe("passed");
    expect(page.digestReads).toBe(2);
    expect(holds).toHaveBeenCalledWith(
      "Late content appears.",
      { complete: true, text: "Late content" },
      {},
    );

    const racing = fakePage("First read");
    racing.setQuietVersion(nextVersion);
    racing.onDigest(() => {
      if (racing.digestReads === 1) {
        racing.setVersion(nextVersion);
        racing.setDigest({
          protocol: 1,
          version: nextVersion,
          text: "Second read",
          complete: true,
        });
      }
    });
    await verify(racing.page, judge, "Second read appears.");
    expect(racing.digestReads).toBe(2);
  });

  it("retries a navigation race during extraction within the same budget", async () => {
    const page = fakePage("Current page");
    page.failNextDigestReads(1);
    const { judge, holds } = fakeJudge();
    await verify(page.page, judge, "Current page is visible");
    expect(page.digestReads).toBe(1);
    expect(holds).toHaveBeenCalledOnce();
  });

  it("rejects a stale page after the Judge response", async () => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    holds.mockImplementation(async () => {
      page.setVersion(nextVersion);
      return { holds: 0.9, contradicted: 0.1, call };
    });
    await expect(verify(page.page, judge, "Claim")).rejects.toMatchObject({
      code: "stale_observation",
    });
    expect(holds).toHaveBeenCalledOnce();
  });

  it("does not return a verdict when the post-Judge version read fails", async () => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    holds.mockImplementation(async () => {
      page.failNextVersionReads(1);
      return { holds: 0.9, contradicted: 0.1, call };
    });
    await expect(verify(page.page, judge, "Claim")).rejects.toMatchObject({
      code: "browser_failure",
    });
  });

  it("keeps provider failure and invalid scores operational", async () => {
    const page = fakePage();
    const { judge, holds } = fakeJudge();
    holds.mockRejectedValueOnce(new Error("provider leaked claim: secret"));
    const failure = await verify(page.page, judge, "Claim").catch(
      (error: unknown) => error,
    );
    if (!(failure instanceof AssertionEngineError))
      throw new Error("Expected an operational error");
    expect(failure).toMatchObject({
      code: "provider_failure",
      message: "Assertion could not be judged: provider_failure.",
    });
    expect(failure.cause).toBeUndefined();
    expect(inspect(failure)).not.toContain("secret");
    expect(String(failure)).not.toContain("secret");
    expect(JSON.stringify(failure)).not.toContain("secret");
    const invalid = fakeJudge(NaN, 0);
    await expect(
      verify(page.page, invalid.judge, "Claim"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    });
  });

  it("cancels a pending read without calling Judge", async () => {
    const controller = new AbortController();
    const page = fakePage();
    page.settle.mockImplementation(() => new Promise(() => undefined));
    const { judge, holds } = fakeJudge();
    const result = verify(page.page, judge, "Claim", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "canceled" });
    expect(holds).not.toHaveBeenCalled();
  });

  it("bounds a pending observation and omits raw causes from JSON", async () => {
    vi.useFakeTimers();
    try {
      const page = fakePage();
      page.settle.mockImplementation(() => new Promise(() => undefined));
      const { judge, holds } = fakeJudge();
      const result = verify(page.page, judge, "Claim", {
        observationTimeoutMs: 10,
      }).catch((value: unknown) => value);
      await vi.advanceTimersByTimeAsync(10);
      const error = await result;
      expect(error).toBeInstanceOf(AssertionEngineError);
      expect(error).toMatchObject({ code: "observation_timeout" });
      expect(JSON.stringify(error)).toBe(
        '{"code":"observation_timeout","message":"Assertion could not be judged: observation_timeout."}',
      );
      expect(holds).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
