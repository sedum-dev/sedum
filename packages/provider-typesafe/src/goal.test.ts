import { describe, expect, it, vi } from "vitest";
import { TypeSafeAdapter } from "./index.js";
import type { GoalState } from "@sedum-dev/core";

const state: GoalState = {
  goal: "Search for plants",
  page: "Search",
  recentActions: [],
  targets: {
    CLICK: { c0: "Search button" },
    TYPE: { t1: "Search field ← {{query}}" },
  },
};
const answer = (choice: string, ids: string[]) => ({
  type: "choice",
  choice,
  confidence: 0.9,
  probabilities: Object.fromEntries(
    ids.map((id) => [id, id === choice ? 1 : 0]),
  ),
});
function reply(operation: string, target: unknown) {
  return new Response(
    JSON.stringify({
      model: "jev-test",
      usage: { input_tokens: 100, output_tokens: 0 },
      answers: {
        operation: answer(operation, ["CLICK", "TYPE", "DONE", "BLOCKED"]),
        click_target: target,
        type_target: { malformed: true },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
describe("goal speculative heads", () => {
  it("selects a value source as one bounded choice with reuse instructions", async () => {
    const choices = {
      BLOCKED: "No suitable source",
      "use.generated_1": "Account email",
      "faker.internet.exampleEmail": "New email",
    };
    const fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.questions)).toEqual(["value"]);
      expect(body.questions.value.criteria).toEqual(choices);
      expect(body.questions.value.instructions.rules).toContain("REUSE");
      expect(body.questions.value.instructions.rules).toContain(
        "Never fabricate existing login credentials",
      );
      expect(body.state.field).toBe("Confirm email");
      return new Response(
        JSON.stringify({
          model: "jev-test",
          usage: { input_tokens: 100, output_tokens: 0 },
          answers: { value: answer("use.generated_1", Object.keys(choices)) },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const result = await new TypeSafeAdapter({
      apiKey: "test",
      fetch,
    }).chooseGoalValue({
      goal: "Create account",
      page: "Signup",
      field: "Confirm email",
      choices,
    });
    expect(result.value.choice).toBe("use.generated_1");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects unoffered generators and does not retry value requests", async () => {
    const input = {
      goal: "Create account",
      page: "Signup",
      field: "Email",
      choices: { BLOCKED: "Unavailable" },
    };
    const fetch = vi.fn(
      async () => new Response("unavailable", { status: 529 }),
    );
    await expect(
      new TypeSafeAdapter({ apiKey: "test", fetch }).chooseGoalValue(input),
    ).rejects.toMatchObject({ attempts: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      new TypeSafeAdapter({
        apiKey: "test",
        fetch: async () =>
          new Response(
            JSON.stringify({
              model: "jev-test",
              usage: { input_tokens: 100, output_tokens: 0 },
              answers: {
                value: answer("faker.helpers.fake", ["faker.helpers.fake"]),
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }).chooseGoalValue(input),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("forwards optional host context without changing target rules or action choices", async () => {
    const fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.declared_data_keys).toEqual(["password", "username"]);
      expect(body.state.completion_criteria).toEqual([
        "Confirmation is visible",
      ]);
      expect(body.questions.operation.instructions.rules).toContain(
        "Fill required fields before submitting.",
      );
      // BLOCKED means no offered control helps, not that a named step is risky.
      expect(body.questions.operation.instructions.rules).toContain(
        "Every step the goal names is expected and safe to perform here",
      );
      expect(body.questions.operation.criteria.BLOCKED).toBe(
        "No offered element or field can move the goal forward from this page; abstain",
      );
      expect(body.questions.click_target.instructions.rules).not.toContain(
        "Fill required fields before submitting.",
      );
      expect(Object.keys(body.questions.operation.criteria)).toEqual([
        "CLICK",
        "TYPE",
        "DONE",
        "BLOCKED",
      ]);
      return reply("DONE", null);
    });
    await new TypeSafeAdapter({ apiKey: "test", fetch }).chooseGoal({
      ...state,
      declaredDataKeys: ["password", "username"],
      completionCriteria: ["Confirmation is visible"],
      operationInstructions: "Fill required fields before submitting.",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [false, "TYPE chooses a field AND supplied binding together."],
    [true, "TYPE chooses one field."],
  ] as const)(
    "changes only automatic-data request semantics when automaticData is %s",
    async (automaticData, targetRule) => {
      let request:
        | {
            state: Record<string, unknown>;
            questions: Record<string, { instructions: { rules: string } }>;
          }
        | undefined;
      const fetch = vi.fn(async (_input, init) => {
        request = JSON.parse(String(init?.body));
        return reply("DONE", null);
      });
      await new TypeSafeAdapter({ apiKey: "test", fetch }).chooseGoal({
        ...state,
        automaticData,
      });
      expect(request?.state).toEqual({
        page: state.page,
        offered_targets: state.targets,
        recent_actions: [],
      });
      expect(request?.questions.click_target?.instructions.rules).toContain(
        targetRule,
      );
      expect(request?.questions.operation?.instructions.rules).toContain(
        automaticData
          ? "Synthetic data is available without advance declarations."
          : "Do not invent values.",
      );
      expect(request?.questions.operation?.instructions.rules).not.toContain(
        automaticData
          ? "TYPE chooses a field AND supplied binding together."
          : "Synthetic data is available without advance declarations.",
      );
    },
  );

  it("accepts 254 targets and rejects the adjacent cardinality boundaries", async () => {
    const targets = Object.fromEntries(
      Array.from({ length: 254 }, (_, index) => [
        `c${index}`,
        `Choice ${index}`,
      ]),
    );
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-test",
            usage: { input_tokens: 100, output_tokens: 0 },
            answers: {
              operation: answer("DONE", ["CLICK", "DONE", "BLOCKED"]),
              click_target: answer("c0", Object.keys(targets)),
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new TypeSafeAdapter({ apiKey: "test", fetch });
    await expect(
      adapter.chooseGoal({ ...state, targets: { CLICK: targets } }),
    ).resolves.toMatchObject({ operation: { choice: "DONE" } });
    for (const invalidTargets of [{}, { ...targets, c254: "Choice 254" }])
      await expect(
        adapter.chooseGoal({
          ...state,
          targets: { CLICK: invalidTargets },
        }),
      ).rejects.toMatchObject({
        code: "invalid-input",
        message: "Invalid goal action space",
      });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects unsupported operation heads before making a request", async () => {
    const fetch = vi.fn(async () => reply("DONE", null));
    await expect(
      new TypeSafeAdapter({ apiKey: "test", fetch }).chooseGoal({
        ...state,
        targets: { SELECT: { s0: "Plant type" } },
      }),
    ).rejects.toMatchObject({
      code: "invalid-input",
      message: "Invalid goal action space",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends every head once but ignores the malformed unused head", async () => {
    const fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.questions)).toEqual([
        "operation",
        "click_target",
        "type_target",
      ]);
      expect(Object.keys(body.questions.operation.criteria)).toEqual([
        "CLICK",
        "TYPE",
        "DONE",
        "BLOCKED",
      ]);
      expect(body.questions.operation.instructions.goal).toBe(
        "Search for plants",
      );
      expect(body.questions.click_target.criteria).toEqual({
        c0: "Search button",
      });
      expect(body.questions.type_target.criteria).toEqual({
        t1: "Search field ← {{query}}",
      });
      expect(body.state.offered_targets).toEqual(state.targets);
      expect(body.state).not.toHaveProperty("declared_data_keys");
      expect(body.state).not.toHaveProperty("completion_criteria");
      return reply("CLICK", answer("c0", ["c0"]));
    });
    const result = await new TypeSafeAdapter({
      apiKey: "test",
      fetch,
    }).chooseGoal(state);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.target?.choice).toBe("c0");
  });
  it("rejects a cross-operation target before returning a decision", async () => {
    const adapter = new TypeSafeAdapter({
      apiKey: "test",
      fetch: async () => reply("CLICK", answer("t1", ["t1"])),
    });
    await expect(adapter.chooseGoal(state)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
  it("DONE ignores every target head", async () => {
    const adapter = new TypeSafeAdapter({
      apiKey: "test",
      fetch: async () => reply("DONE", null),
    });
    expect((await adapter.chooseGoal(state)).target).toBeUndefined();
  });
  it("does not retry a failed HTTP attempt", async () => {
    const fetch = vi.fn(
      async () => new Response("unavailable", { status: 529 }),
    );
    const adapter = new TypeSafeAdapter({ apiKey: "test", fetch });
    await expect(adapter.chooseGoal(state)).rejects.toMatchObject({
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
