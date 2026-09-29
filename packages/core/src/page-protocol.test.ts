import { test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  CANDIDATE_LIMIT,
  DIGEST_LIMIT,
  NAME_LIMIT,
  PEER_LIMIT,
  projectCandidates,
  projectDigest,
  type Candidate,
  type CandidatePage,
} from "./page-protocol.js";

const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 1000,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const candidateGenerator = gs.record({
  ref: gs.text({ minSize: 1, maxSize: 16 }),
  tag: gs.sampledFrom(["button", "input"]),
  role: gs.sampledFrom(["", "button", "textbox"]),
  name: gs.text({ maxSize: 24 }),
  peers: gs.arrays(gs.text({ maxSize: 16 }), { maxSize: 2 }),
  editable: gs.booleans(),
  disabled: gs.booleans(),
  inputType: gs.text({ maxSize: 16 }),
  signals: gs.record({ path: gs.text({ maxSize: 24 }) }),
});
function makeCandidate(
  overrides: {
    readonly ref?: string;
    readonly role?: string;
    readonly name?: string;
    readonly peers?: readonly string[];
  } = {},
): Candidate {
  return {
    ref: overrides.ref ?? "candidate",
    tag: "button",
    role: overrides.role ?? "button",
    name: overrides.name ?? "Item",
    peers: overrides.peers ?? ["Context"],
    editable: false,
    disabled: false,
    inputType: "",
    signals: { path: "body:0/button:0" },
  };
}
function pageFor(
  candidates: readonly Candidate[],
  complete = true,
): CandidatePage {
  return {
    protocol: 1,
    version: { document: "document", revision: 1, route: "/" },
    total: candidates.length,
    offset: 0,
    next: null,
    complete,
    candidates,
  };
}
function errorMessage(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

propertyTest("page candidate projection exposes only provider fields", () => {
  hegel.test((tc) => {
    const candidate: Candidate = tc.draw(candidateGenerator);
    const page: CandidatePage = {
      protocol: 1,
      version: { document: "document", revision: 1, route: "/" },
      total: 1,
      offset: 0,
      next: null,
      complete: true,
      candidates: [candidate],
    };
    const [projected] = projectCandidates(page);
    if (!projected) throw new Error("Candidate projection was empty");
    if (
      projected.id !== candidate.ref ||
      projected.tag !== candidate.tag ||
      projected.role !== candidate.role ||
      projected.name !== candidate.name ||
      projected.editable !== candidate.editable ||
      projected.disabled !== candidate.disabled ||
      JSON.stringify(projected.peers) !== JSON.stringify(candidate.peers)
    )
      throw new Error("Candidate projection changed provider-visible data");
    if (
      Object.keys(projected).sort().join(",") !==
      "disabled,editable,id,name,peers,role,tag"
    )
      throw new Error("Local candidate fields crossed the provider boundary");
  }, propertySettings);
});

propertyTest("complete page digests preserve bounded text", () => {
  hegel.test((tc) => {
    const text = tc.draw(gs.text({ maxSize: DIGEST_LIMIT }));
    const result = projectDigest({
      protocol: 1,
      version: { document: "document", revision: 1, route: "/" },
      text,
      complete: true,
    });
    if (result !== text) throw new Error("Digest text was changed");
  }, propertySettings);
});

propertyTest("incomplete candidate pages are rejected", () => {
  hegel.test((tc) => {
    const candidate: Candidate = tc.draw(candidateGenerator);
    const message = errorMessage(() =>
      projectCandidates(pageFor([candidate], false)),
    );
    if (message !== "candidate_set_incomplete")
      throw new Error("An incomplete candidate page was accepted");
  }, propertySettings);
});

propertyTest("candidate names use code-point limits", () => {
  hegel.test((tc) => {
    const size = tc.draw(gs.sampledFrom([NAME_LIMIT, NAME_LIMIT + 1]));
    const name = "😀".repeat(size);
    const message = errorMessage(() =>
      projectCandidates(pageFor([makeCandidate({ name })])),
    );
    if (size === NAME_LIMIT) {
      const [projected] = projectCandidates(pageFor([makeCandidate({ name })]));
      if (message || projected?.name !== name)
        throw new Error("A name at the exact code-point limit was rejected");
    } else if (message !== "candidate_field_too_large") {
      throw new Error("An oversized candidate name was accepted");
    }
  }, propertySettings);
});

propertyTest("candidate peers use code-point limits", () => {
  hegel.test((tc) => {
    const size = tc.draw(gs.sampledFrom([PEER_LIMIT, PEER_LIMIT + 1]));
    const peer = "😀".repeat(size);
    const message = errorMessage(() =>
      projectCandidates(pageFor([makeCandidate({ peers: [peer] })])),
    );
    if (size === PEER_LIMIT) {
      const [projected] = projectCandidates(
        pageFor([makeCandidate({ peers: [peer] })]),
      );
      if (message || projected?.peers[0] !== peer)
        throw new Error("A peer at the exact code-point limit was rejected");
    } else if (message !== "candidate_field_too_large") {
      throw new Error("An oversized candidate peer was accepted");
    }
  }, propertySettings);
});

propertyTest("candidate count limits reject only the first overflow", () => {
  hegel.test((tc) => {
    const count = tc.draw(
      gs.sampledFrom([CANDIDATE_LIMIT, CANDIDATE_LIMIT + 1]),
    );
    const candidates = Array.from({ length: count }, (_, index) =>
      makeCandidate({ ref: `candidate-${index}` }),
    );
    const message = errorMessage(() => projectCandidates(pageFor(candidates)));
    if (count === CANDIDATE_LIMIT) {
      const projected = projectCandidates(pageFor(candidates));
      if (message || projected.length !== count)
        throw new Error(
          "A candidate page at the exact count limit was rejected",
        );
    } else if (message !== "candidate_set_incomplete") {
      throw new Error("An oversized candidate page was accepted");
    }
  }, propertySettings);
});

propertyTest("unsafe candidate roles are rejected", () => {
  hegel.test((tc) => {
    const suffix = tc.draw(gs.text({ maxSize: 24 }));
    const message = errorMessage(() =>
      projectCandidates(pageFor([makeCandidate({ role: `unsafe:${suffix}` })])),
    );
    if (message !== "candidate_field_too_large")
      throw new Error("An unsafe candidate role crossed the provider boundary");
  }, propertySettings);
});

propertyTest("digest errors are preserved as typed rejection reasons", () => {
  hegel.test((tc) => {
    const error = tc.draw(
      gs.sampledFrom([
        "digest_too_large",
        "resource_ceiling",
        "scope_ambiguous",
      ] as const),
    );
    const message = errorMessage(() =>
      projectDigest({
        protocol: 1,
        version: { document: "document", revision: 1, route: "/" },
        text: "bounded text",
        complete: true,
        error,
      }),
    );
    if (message !== error)
      throw new Error(
        "A digest error was not preserved at the provider boundary",
      );
  }, propertySettings);
});

propertyTest(
  "digest limits accept exact bounds and reject the first overflow",
  () => {
    hegel.test((tc) => {
      const size = tc.draw(gs.sampledFrom([DIGEST_LIMIT, DIGEST_LIMIT + 1]));
      const text = "😀".repeat(size);
      const message = errorMessage(() =>
        projectDigest({
          protocol: 1,
          version: { document: "document", revision: 1, route: "/" },
          text,
          complete: true,
        }),
      );
      if (size === DIGEST_LIMIT) {
        if (
          message ||
          projectDigest({
            protocol: 1,
            version: { document: "document", revision: 1, route: "/" },
            text,
            complete: true,
          }) !== text
        )
          throw new Error(
            "A digest at the exact code-point limit was rejected",
          );
      } else if (message !== "digest_incomplete") {
        throw new Error("An oversized digest was accepted");
      }
    }, propertySettings);
  },
);
