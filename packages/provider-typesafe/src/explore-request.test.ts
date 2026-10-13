import { describe, expect, it } from "vitest";
import {
  ProviderError,
  type ExploreAdviceRequest,
  type ExploreDecisionRequest,
} from "@sedum-dev/core";
import {
  buildDecisionRequest,
  buildExploreRequest,
  validateDecision,
  validateExploreAdvice,
} from "./explore-request.js";

const input: ExploreAdviceRequest = {
  route: "/account",
  title: "Your account",
  page: "Your account Danger zone",
  targets: {
    t0: { role: "button", name: "Delete account" },
    t1: { role: "link", name: "Reports", href: "/account/reports" },
  },
  kinds: { account: "Settings", admin: "Admin tools", other: "None" },
  predictTargets: true,
};

describe("exploration request", () => {
  it("fans out page kind, safety and destination questions in one call", () => {
    const { request, targetIds } = buildExploreRequest(input, "jev-latest");
    expect(targetIds).toEqual(["t0", "t1"]);
    expect(Object.keys(request.questions).sort()).toEqual([
      "destructive_t0",
      "destructive_t1",
      "leads_t0",
      "leads_t1",
      "page_kind",
    ]);
    expect(request.questions.destructive_t0?.type).toBe("noul");
    expect(request.questions.page_kind?.type).toBe("choice");
  });

  it("asks only safety questions when predictions are off", () => {
    const { request } = buildExploreRequest(
      { ...input, predictTargets: false },
      "jev-latest",
    );
    expect(Object.keys(request.questions)).not.toContain("leads_t0");
  });

  it("validates every answer against the offered options", () => {
    const leads = {
      type: "choice",
      choice: "admin",
      confidence: 0.8,
      probabilities: { account: 0.1, admin: 0.85, other: 0.05 },
    };
    const advice = validateExploreAdvice(input, ["t0", "t1"], {
      answers: {
        page_kind: {
          type: "choice",
          choice: "account",
          confidence: 0.9,
          probabilities: { account: 0.95, admin: 0.04, other: 0.01 },
        },
        destructive_t0: { type: "noul", noul: 0.97 },
        destructive_t1: { type: "noul", noul: 0.02 },
        leads_t0: leads,
        leads_t1: leads,
      },
    });
    expect(advice.kind.choice).toBe("account");
    expect(advice.destructive).toEqual({ t0: 0.97, t1: 0.02 });
    expect(advice.leadsTo.t1?.admin).toBe(0.85);
    expect(() =>
      validateExploreAdvice(input, ["t0"], { answers: { page_kind: {} } }),
    ).toThrow(ProviderError);
  });

  it("rejects too many targets", () => {
    const targets = Object.fromEntries(
      Array.from({ length: 61 }, (_, i) => [
        `t${i}`,
        { role: "link", name: `L${i}` },
      ]),
    );
    expect(() =>
      buildExploreRequest({ ...input, targets }, "jev-latest"),
    ).toThrow(ProviderError);
  });
});

describe("exploration decisions", () => {
  const decision: ExploreDecisionRequest = {
    page: "Add new account",
    subject: { error0: "Wrapper type is required" },
    questions: {
      line0: {
        question: "Which form field is the error about?",
        choices: { none: "No field", f0: "Account name", f1: "Wrapper type" },
      },
    },
  };

  it("asks every question about one subject in one call", () => {
    const request = buildDecisionRequest(decision, "jev-latest");
    expect(Object.keys(request.questions)).toEqual(["line0"]);
    expect(request.questions.line0?.type).toBe("choice");
    expect(JSON.stringify(request.state)).toContain("Wrapper type is required");
  });

  it("rejects a question with fewer than two options", () => {
    expect(() =>
      buildDecisionRequest(
        {
          ...decision,
          questions: { q: { question: "?", choices: { only: null } } },
        },
        "jev-latest",
      ),
    ).toThrow(ProviderError);
  });

  it("validates each answer against its own options", () => {
    const answer = {
      type: "choice",
      choice: "f1",
      confidence: 0.9,
      probabilities: { none: 0.02, f0: 0.03, f1: 0.95 },
    };
    expect(
      validateDecision(decision, { answers: { line0: answer } }).answers.line0
        ?.choice,
    ).toBe("f1");
    expect(() =>
      validateDecision(decision, {
        answers: { line0: { ...answer, choice: "f9" } },
      }),
    ).toThrow();
  });
});

describe("large exploration requests", () => {
  it("asks about as many targets as fit, in page order", () => {
    const long = "A very long target name that repeats ".repeat(20);
    const targets = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `t${i}`,
        { role: "button", name: `${long}${i}` },
      ]),
    );
    const { request, targetIds } = buildExploreRequest(
      { ...input, targets },
      "jev-latest",
    );
    expect(targetIds.length).toBeGreaterThan(0);
    expect(targetIds.length).toBeLessThan(60);
    expect(targetIds[0]).toBe("t0");
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
      64 * 1024,
    );
  });
});

describe("page checks in the exploration request", () => {
  it("asks the bug detector's questions and returns its inspection", () => {
    const asked = { ...input, inspect: true };
    const { request, targetIds } = buildExploreRequest(asked, "jev-latest");
    const keys = Object.keys(request.questions).filter((k) =>
      k.startsWith("inspect_"),
    );
    expect(keys.sort()).toEqual([
      "inspect_broken_value",
      "inspect_empty_content",
      "inspect_error_message",
      "inspect_severity",
      "inspect_stuck_loading",
    ]);
    const noul = (value: number) => ({ type: "noul", noul: value });
    const choiceOf = (choice: string, ids: string[]) => ({
      type: "choice",
      choice,
      confidence: 0.9,
      probabilities: Object.fromEntries(
        ids.map((id) => [id, id === choice ? 1 : 0]),
      ),
    });
    const kinds = Object.keys(input.kinds);
    const advice = validateExploreAdvice(asked, targetIds, {
      answers: {
        page_kind: choiceOf("account", kinds),
        destructive_t0: noul(0.9),
        destructive_t1: noul(0.1),
        leads_t0: choiceOf("other", kinds),
        leads_t1: choiceOf("other", kinds),
        inspect_error_message: noul(0.8),
        inspect_stuck_loading: noul(0.1),
        inspect_empty_content: noul(0.2),
        inspect_broken_value: noul(0.7),
        inspect_severity: {
          type: "score",
          score: 2,
          confidence: 0.7,
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.6, "3": 0.2 },
        },
      },
    });
    expect(advice.inspection?.probabilities.error_message).toBe(0.8);
    expect(advice.inspection?.severity.score).toBe(2);
  });

  it("asks no page checks unless requested", () => {
    const { request } = buildExploreRequest(input, "jev-latest");
    expect(
      Object.keys(request.questions).some((k) => k.startsWith("inspect_")),
    ).toBe(false);
  });
});
