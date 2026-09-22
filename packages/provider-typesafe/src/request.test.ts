import { describe, expect, it } from "vitest";
import { buildJudgeRequest, buildResolverRequest } from "./request.js";
import type { ResolverCandidate, ResolverCandidates } from "@sedum-dev/core";

function candidate(id: string, name = "Checkout"): ResolverCandidate {
  return {
    id,
    tag: "button",
    role: "button",
    name,
    peers: ["Cart"],
    editable: false,
    disabled: false,
  };
}
function offered(...items: ResolverCandidate[]): ResolverCandidates {
  return {
    complete: true,
    options: items.map((item) => ({ kind: "candidate", candidate: item })),
  };
}

describe("allowlisted TypeSafe requests", () => {
  it("projects only permitted candidate and digest fields", () => {
    const withExtras = {
      ...candidate("a", "token-looks-secret"),
      url: "URLSECRET",
      value: "INPUTSECRET",
      signals: { path: "SELECTORSECRET" },
    };
    const resolver = buildResolverRequest(
      "click the button",
      offered(withExtras),
    ).request;
    const wire = JSON.stringify(resolver);
    expect(wire).toContain("token-looks-secret");
    expect(wire).not.toMatch(/URLSECRET|INPUTSECRET|SELECTORSECRET/);
    expect(Object.keys(resolver)).toEqual(["state", "questions", "model"]);

    const digest = {
      complete: true,
      text: "customer-like-text",
      url: "URLSECRET",
      title: "TITLESECRET",
    };
    const judge = buildJudgeRequest("Order is complete", digest);
    expect(JSON.stringify(judge)).toContain("customer-like-text");
    expect(JSON.stringify(judge)).not.toMatch(/URLSECRET|TITLESECRET/);
    expect(Object.keys(judge.questions)).toEqual(["holds", "contradicted"]);
    expect(judge.state).toEqual({
      claim: "Order is complete",
      page: "customer-like-text",
    });
  });

  it("rejects incomplete extraction and over-limit Unicode fields", () => {
    expect(() =>
      buildResolverRequest("click", {
        ...offered(candidate("a")),
        complete: false,
      }),
    ).toThrow();
    expect(() =>
      buildResolverRequest("x".repeat(513), offered(candidate("a"))),
    ).toThrow();
    expect(() =>
      buildResolverRequest("click", offered(candidate("a", "😀".repeat(121)))),
    ).toThrow();
    expect(() =>
      buildResolverRequest(
        "click",
        offered({ ...candidate("a"), peers: ["😀".repeat(81)] }),
      ),
    ).toThrow();
    expect(() =>
      buildJudgeRequest("claim", { complete: false, text: "page" }),
    ).toThrow();
    expect(() =>
      buildJudgeRequest("claim", { complete: true, text: "😀".repeat(4097) }),
    ).toThrow();
  });

  it("rejects duplicate or excessive Choice options without dropping any", () => {
    expect(() =>
      buildResolverRequest("click", offered(candidate("a"), candidate("a"))),
    ).toThrow();
    expect(() =>
      buildResolverRequest(
        "click",
        offered(...Array.from({ length: 129 }, (_, i) => candidate("c" + i))),
      ),
    ).toThrow();
    const many = offered(
      ...Array.from({ length: 255 }, (_, i) => candidate("c" + i)),
    );
    expect(() =>
      buildResolverRequest("click", {
        complete: true,
        options: [...many.options, { kind: "none", id: "none" }],
      }),
    ).toThrow();
  });

  it("mentions no-match only when the caller offers that option", () => {
    const without = buildResolverRequest(
      "click",
      offered(candidate("a")),
    ).request;
    const withNone = buildResolverRequest("click", {
      complete: true,
      options: [
        ...offered(candidate("a")).options,
        { kind: "none", id: "none" },
      ],
    }).request;
    expect(JSON.stringify(without.questions)).not.toContain("Choose `none`");
    expect(JSON.stringify(withNone.questions)).toContain("Choose `none`");
  });

  it("measures the complete serialized UTF-8 body", () => {
    const small = offered(
      ...Array.from({ length: 30 }, (_, i) =>
        candidate("c" + i, "😀".repeat(120)),
      ),
    );
    expect(() => buildResolverRequest("click", small)).not.toThrow();
    const large = offered(
      ...Array.from({ length: 128 }, (_, i) => ({
        ...candidate("c" + i, "😀".repeat(120)),
        peers: ["😀".repeat(80), "😀".repeat(80)],
      })),
    );
    expect(() => buildResolverRequest("click", large)).toThrow(/64 KiB/);
  });
});
