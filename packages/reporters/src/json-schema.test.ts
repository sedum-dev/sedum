import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  RunRecorder,
  runResultJsonSchema,
  type RunResult,
} from "@sedum-dev/core";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { renderJson } from "./index.js";
import { fixtures, reportStep, unexecutedTest } from "./test-fixtures.js";

const published = fileURLToPath(
  new URL("../../core/dist/run-result.schema.json", import.meta.url),
);

function validator(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  formats.default(ajv);
  return ajv.compile(schema);
}

async function samples(): Promise<RunResult[]> {
  const recorder = new RunRecorder(async () => undefined, "live-snapshot");
  await recorder.start();
  await recorder.startTest({ id: "live", file: "live.test.yaml" });
  await recorder.addStep(reportStep("live-action", 1, "action"));
  const running = recorder.snapshot;
  await recorder.finishTest("failed");
  await recorder.finish();
  return [
    running,
    recorder.snapshot,
    await fixtures.clean(),
    await fixtures.mixed(),
    await fixtures.flagged("both"),
    await fixtures.retriesExhausted(),
    await fixtures.operationalError(),
    await fixtures.interrupted(),
    await fixtures.flaggedThenTimeout(),
    await fixtures.moduleBinding(),
    await fixtures.noTests(),
    await fixtures.discovery(),
    await fixtures.frames(),
    await fixtures.hostile(),
    await unexecutedTest(),
  ];
}

describe("json reporter", () => {
  it("writes results that validate against the RunResult JSON Schema", async () => {
    const validate = validator(runResultJsonSchema());
    for (const result of await samples()) {
      const valid = validate(JSON.parse(renderJson(result)));
      expect(validate.errors ?? [], result.runId).toEqual([]);
      expect(valid).toBe(true);
    }
    expect(validate({ schemaVersion: 2 })).toBe(false);
  });

  // The file users install; CI builds before testing, so it exists there.
  it.skipIf(!existsSync(published))(
    "validates against the built run-result.schema.json that ships",
    async () => {
      const schema = JSON.parse(await readFile(published, "utf8")) as object;
      expect(schema).toEqual(JSON.parse(JSON.stringify(runResultJsonSchema())));
      const validate = validator(schema);
      for (const result of await samples())
        expect(validate(JSON.parse(renderJson(result))), result.runId).toBe(
          true,
        );
    },
  );
});
