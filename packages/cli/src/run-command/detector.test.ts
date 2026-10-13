import { BugDetector } from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import { DetectorUnsupportedError, setupDiagnostic } from "../diagnostics.js";
import { createDetector } from "./detector.js";

const jev = { inspectPage: async () => ({}) };

describe("createDetector", () => {
  it("is off unless asked for", () => {
    expect(createDetector({}, jev, "typesafe")).toBeUndefined();
    expect(createDetector({ detect: "off" }, jev, "typesafe")).toBeUndefined();
  });

  it("needs no model for browser checks", () => {
    expect(createDetector({ detect: "browser" }, {}, "clef")).toBeInstanceOf(
      BugDetector,
    );
  });

  it("asks a System One provider for page checks", () => {
    expect(
      createDetector({ detect: "semantic" }, jev, "typesafe"),
    ).toBeInstanceOf(BugDetector);
  });

  it("names the provider that cannot run page checks", () => {
    let thrown: unknown;
    try {
      createDetector({ detect: "semantic" }, {}, "clef");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DetectorUnsupportedError);
    expect(setupDiagnostic(thrown, "clef")).toEqual({
      code: "detect_unsupported",
      message:
        "--detect semantic needs a System One provider; clef cannot answer its page questions.",
      fix: "Use --detect browser with this provider, or select the TypeSafe or OpenRouter provider.",
    });
  });
});
