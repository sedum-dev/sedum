import { describe, expect, it } from "vitest";
import { TypeSafeAdapter } from "./index.js";

const live = process.env.SEDUM_TYPESAFE_LIVE === "1";

describe.skipIf(!live)("opt-in TypeSafe integration", () => {
  it("runs one Resolver Choice and one two-question Judge call", async () => {
    const adapter = new TypeSafeAdapter();
    const selection = await adapter.choose("Select the Save button", {
      complete: true,
      options: [
        {
          kind: "candidate",
          candidate: {
            id: "save",
            tag: "button",
            role: "button",
            name: "Save",
            peers: [],
            editable: false,
            disabled: false,
          },
        },
        { kind: "none", id: "none" },
      ],
    });
    expect(["save", "none"]).toContain(
      selection.selection.kind === "none" ? "none" : selection.selection.id,
    );
    expect(selection.call.model.length).toBeGreaterThan(0);
    expect(selection.call.usage.inputTokens).toBeGreaterThanOrEqual(0);
    const judgment = await adapter.holds("The page says Saved", {
      complete: true,
      text: "Saved",
    });
    expect(judgment.holds).toBeGreaterThanOrEqual(0);
    expect(judgment.holds).toBeLessThanOrEqual(1);
    expect(judgment.contradicted).toBeGreaterThanOrEqual(0);
    expect(judgment.contradicted).toBeLessThanOrEqual(1);
    expect(judgment.call.model.length).toBeGreaterThan(0);
    // Metadata only. Keep request text and credentials out of test output.
    process.stdout.write(
      JSON.stringify({ resolver: selection.call, judge: judgment.call }) + "\n",
    );
  });
});
