import { describe, expect, it } from "vitest";
import { ProviderError, type ExploreAdviceRequest } from "@sedum-dev/core";
import {
  buildExploreRequest,
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
