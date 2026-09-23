import { BrowserDriverError, ProviderError } from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import {
  flowDiagnostic,
  outputDiagnostic,
  renderDiagnostic,
  setupDiagnostic,
} from "./diagnostics.js";

describe("actionable CLI diagnostics", () => {
  it("maps safe typed setup failures and hides arbitrary causes", () => {
    expect(
      setupDiagnostic(new ProviderError("configuration", "secret")),
    ).toEqual({
      code: "missing_key",
      message: "The TypeSafe provider is not configured.",
      fix: "Set TYPESAFE_API_KEY and rerun the command.",
    });
    expect(
      setupDiagnostic(
        new BrowserDriverError("browser-missing", "private executable path"),
      ),
    ).toMatchObject({
      code: "browser_missing",
      fix: expect.stringContaining("browsers install chromium"),
    });
    expect(setupDiagnostic(new Error("upstream secret"))).toMatchObject({
      code: "setup_or_output_error",
      message: expect.not.stringContaining("secret"),
    });
  });

  it("renders an output path and explicit fix", () => {
    const diagnostic = outputDiagnostic("/repo/.sedum/runs/1/result.json");
    expect(renderDiagnostic(diagnostic)).toBe(
      "The run result could not be written to /repo/.sedum/runs/1/result.json.\n" +
        "Fix: Make the .sedum output directory writable and rerun the command.\n",
    );
  });

  it("does not render unknown runtime messages or sentinel secrets", () => {
    const diagnostic = flowDiagnostic({
      code: "execution_error",
      message: `${"x".repeat(700)} sentinel-secret`,
      fix: "leak sentinel-secret",
    });
    expect(renderDiagnostic(diagnostic)).not.toContain("sentinel-secret");
    expect(diagnostic.message.length).toBeLessThanOrEqual(512);
  });
});
