import { describe, expect, it } from "vitest";
import { ProviderGate } from "@sedum-dev/core";
import { ClefAdapter } from "./index.js";

const live = process.env.SEDUM_CLEF_LIVE === "1";
describe.skipIf(!live)("opt-in Clef integration", () => {
  it.each(["clef", "clef-flash"])(
    "runs six synthetic text operations on %s",
    async (model) => {
      const gate = new ProviderGate();
      const adapter = new ClefAdapter({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        apiKey: process.env.CLOUDFLARE_AUTH_TOKEN!,
        model,
        gate,
        attemptTimeoutMs: 30_000,
      });
      const once = { maxAttempts: 1 as const };
      try {
        const result = await adapter.choose(
          "Select Save",
          {
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
          },
          once,
        );
        expect(result.selection).toEqual({ kind: "candidate", id: "save" });
        expect(result.call.provider).toBe("clef");
        const judge = await adapter.holds(
          "The page says Saved",
          { complete: true, text: "Saved" },
          once,
        );
        expect(judge.holds).toBeGreaterThan(judge.contradicted);
        const items = await adapter.verifyItems(
          "Choose the red shirt",
          [
            { id: "blue", text: "Blue trousers" },
            { id: "red", text: "Red shirt" },
          ],
          once,
        );
        expect(items.scores.red).toBeGreaterThan(items.scores.blue!);
        const classification = await adapter.classifyBatch(
          ["Click Save", "Verify the page says Saved"],
          once,
        );
        expect(classification.answers.map((a) => a.op)).toEqual([
          "click",
          "verify",
        ]);
        const goal = await adapter.chooseGoal(
          {
            goal: "Click Save",
            page: "The Save button is visible and enabled.",
            recentActions: [],
            targets: {
              CLICK: {
                save: "Save button",
                __sedum_no_match: "No appropriate target",
              },
            },
          },
          once,
        );
        expect(goal.operation.choice).toBe("CLICK");
        expect(goal.target?.choice).toBe("save");
        const relevance = await adapter.scoreRelevance(
          "- button label: Save\n+ button label: Submit",
          [
            {
              file: "save.test.yaml",
              source: "steps:\n  - click Save",
              modules: [],
            },
          ],
          once,
        );
        expect(relevance.probabilities[0]).toBeGreaterThan(0.5);
        // Synthetic inputs only; output is limited to usage receipts, never credentials.
        process.stdout.write(
          JSON.stringify({
            model,
            calls: [
              result.call,
              judge.call,
              items.call,
              ...classification.calls,
              goal.call,
              ...relevance.calls,
            ],
          }) + "\n",
        );
      } finally {
        gate.close();
      }
    },
    120_000,
  );
});
