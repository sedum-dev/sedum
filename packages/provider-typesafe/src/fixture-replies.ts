import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Fetch } from "@typesafe-ai/sdk";

interface CassetteEntry {
  readonly key: string;
  readonly request: Record<string, unknown>;
  readonly response: Record<string, unknown>;
}
interface CassetteFile {
  readonly version: 1;
  readonly entries: readonly CassetteEntry[];
}
interface CanonicalRequest {
  readonly key: string;
  readonly request: Record<string, unknown>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly originals: ReadonlyMap<string, string>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid fixture reply shape");
  return value as Record<string, unknown>;
}

function assertFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).sort().join(",") !== fields.sort().join(","))
    throw new Error("Unexpected fixture provider fields");
}

function assertFixtureText(value: unknown): void {
  if (typeof value === "string") {
    if (
      /(?:https?:\/\/|www\.|bearer\s+|sk-[a-z0-9]{12,}|api[_-]?key\s*[:=])/iu.test(
        value,
      ) ||
      (process.env.TYPESAFE_API_KEY &&
        value.includes(process.env.TYPESAFE_API_KEY))
    )
      throw new Error("External URL or secret in fixture provider data");
  } else if (Array.isArray(value)) {
    value.forEach(assertFixtureText);
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => {
      assertFixtureText(key);
      assertFixtureText(nested);
    });
  }
}

function canonicalize(body: string): CanonicalRequest {
  const request = object(JSON.parse(body) as unknown);
  if (
    Object.keys(request).sort().join(",") !== "model,questions,state" ||
    request.model !== "jev-latest"
  )
    throw new Error("Unexpected fixture provider request fields");
  const state = object(request.state);
  const questions = object(request.questions);
  assertFixtureText(request);
  const questionKeys = Object.keys(questions);
  if (questionKeys.length === 0)
    throw new Error("Empty fixture provider questions");
  if (Object.hasOwn(questions, "target")) {
    if (
      questionKeys.length !== 1 ||
      Object.keys(state).join(",") !== "sentence"
    )
      throw new Error("Unexpected fixture Resolver request");
  } else if (Object.hasOwn(questions, "holds")) {
    if (
      questionKeys.sort().join(",") !== "contradicted,holds" ||
      Object.keys(state).sort().join(",") !== "claim,page"
    )
      throw new Error("Unexpected fixture Judge request");
    for (const question of Object.values(questions)) {
      const item = object(question);
      assertFields(item, ["type", "instructions", "criteria"]);
      if (item.type !== "noul" || typeof item.instructions !== "string")
        throw new Error("Unexpected fixture Judge question");
      const criteria = object(item.criteria);
      assertFields(criteria, ["true", "false"]);
      if (!Object.values(criteria).every((v) => typeof v === "string"))
        throw new Error("Unexpected fixture Judge criteria");
    }
  } else if (
    Object.keys(state).length !== 0 ||
    !questionKeys.every((key) => /^line\d+$/u.test(key))
  )
    throw new Error("Unexpected fixture classification request");
  else {
    for (const question of Object.values(questions)) {
      const item = object(question);
      assertFields(item, ["type", "instructions", "criteria"]);
      if (item.type !== "choice" || typeof item.instructions !== "string")
        throw new Error("Unexpected fixture classification question");
      const criteria = object(item.criteria);
      if (!Object.values(criteria).every((v) => typeof v === "string"))
        throw new Error("Unexpected fixture classification criteria");
    }
  }
  const aliases = new Map<string, string>();
  const originals = new Map<string, string>();
  if (Object.hasOwn(questions, "target")) {
    const target = object(questions.target);
    assertFields(target, ["type", "instructions", "criteria"]);
    if (target.type !== "choice" || typeof target.instructions !== "string")
      throw new Error("Unexpected fixture Resolver shape");
    const criteria = object(target.criteria);
    const normalized: Record<string, unknown> = {};
    let index = 0;
    for (const [id, description] of Object.entries(criteria)) {
      if (id === "none") {
        if (typeof description !== "string")
          throw new Error("Unexpected fixture none option");
      } else {
        const candidate = object(description);
        assertFields(candidate, [
          "tag",
          "role",
          "name",
          "peers",
          "editable",
          "disabled",
        ]);
        if (
          ![candidate.tag, candidate.role, candidate.name].every(
            (v) => typeof v === "string",
          ) ||
          !Array.isArray(candidate.peers) ||
          !candidate.peers.every((v: unknown) => typeof v === "string") ||
          typeof candidate.editable !== "boolean" ||
          typeof candidate.disabled !== "boolean"
        )
          throw new Error("Unexpected fixture candidate shape");
      }
      const alias = id === "none" ? "none" : `candidate_${index++}`;
      if (aliases.has(id) || originals.has(alias))
        throw new Error("Duplicate fixture candidate ID");
      aliases.set(id, alias);
      originals.set(alias, id);
      normalized[alias] = description;
    }
    questions.target = { ...target, criteria: normalized };
  }
  const normalized = { model: request.model, state, questions };
  const key = createHash("sha256")
    .update("sedum-fixture-reply-v1\0")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return { key, request: normalized, aliases, originals };
}

function remapReply(
  raw: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (names.size === 0) return raw;
  const answers = object(raw.answers);
  const target = object(answers.target);
  const choice = target.choice;
  if (typeof choice !== "string" || !names.has(choice))
    throw new Error("Fixture reply chose an unknown candidate");
  const probabilities = object(target.probabilities);
  if (
    Object.keys(probabilities).length !== names.size ||
    Object.keys(probabilities).some((id) => !names.has(id))
  )
    throw new Error("Fixture reply has mismatched candidate probabilities");
  return {
    ...raw,
    answers: {
      ...answers,
      target: {
        ...target,
        choice: names.get(choice),
        probabilities: Object.fromEntries(
          Object.entries(probabilities).map(([id, value]) => [
            names.get(id),
            value,
          ]),
        ),
      },
    },
  };
}

function validateResponse(value: unknown): Record<string, unknown> {
  const response = object(value);
  assertFields(response, ["answers", "model", "usage"]);
  assertFixtureText(response);
  if (typeof response.model !== "string")
    throw new Error("Unexpected fixture response model");
  const usage = object(response.usage);
  assertFields(usage, ["input_tokens", "output_tokens"]);
  if (
    !Object.values(usage).every(
      (v) => Number.isSafeInteger(v) && (v as number) >= 0,
    )
  )
    throw new Error("Unexpected fixture response usage");
  for (const answer of Object.values(object(response.answers))) {
    const item = object(answer);
    if (item.type === "choice") {
      assertFields(item, ["type", "choice", "confidence", "probabilities"]);
      if (
        typeof item.choice !== "string" ||
        typeof item.confidence !== "number"
      )
        throw new Error("Unexpected fixture choice reply");
      if (
        !Object.values(object(item.probabilities)).every(
          (v) => typeof v === "number",
        )
      )
        throw new Error("Unexpected fixture probabilities");
    } else if (item.type === "noul") {
      assertFields(item, ["type", "noul"]);
      if (typeof item.noul !== "number")
        throw new Error("Unexpected fixture noul reply");
    } else throw new Error("Unexpected fixture answer type");
  }
  return response;
}

function validateFile(value: unknown): CassetteFile {
  const file = object(value);
  if (file.version !== 1 || !Array.isArray(file.entries))
    throw new Error("Fixture replies have an unsupported format");
  const entries = file.entries as unknown[];
  let previous = "";
  for (const entryValue of entries) {
    const entry = object(entryValue);
    if (
      typeof entry.key !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.key) ||
      entry.key <= previous ||
      typeof entry.request !== "object" ||
      typeof entry.response !== "object"
    )
      throw new Error(
        "Fixture replies contain duplicate, unsorted, or invalid entries",
      );
    previous = entry.key;
    const actual = canonicalize(JSON.stringify(entry.request));
    if (actual.key !== entry.key)
      throw new Error(`Fixture reply key is stale: ${entry.key}`);
    validateResponse(entry.response);
  }
  return value as CassetteFile;
}

/** Test-only SDK transport. Normal mode has no network fallback. */
export class FixtureReplies {
  readonly fetch: Fetch;
  readonly missing: string[] = [];
  readonly used = new Set<string>();
  private readonly entries: Map<string, CassetteEntry>;
  private readonly recorded = new Map<string, CassetteEntry>();

  private constructor(
    readonly path: string,
    readonly recording: boolean,
    file: CassetteFile,
  ) {
    this.entries = new Map(file.entries.map((entry) => [entry.key, entry]));
    this.fetch = async (input, init) => {
      const body = String(init?.body ?? "");
      const canonical = canonicalize(body);
      this.used.add(canonical.key);
      if (this.recording) {
        const response = await (globalThis.fetch as Fetch)(input, init);
        if (!response.ok) return response;
        const raw = object((await response.clone().json()) as unknown);
        const normalized = validateResponse(
          remapReply(
            { answers: raw.answers, model: raw.model, usage: raw.usage },
            canonical.aliases,
          ),
        );
        this.recorded.set(canonical.key, {
          key: canonical.key,
          request: canonical.request,
          response: normalized,
        });
        return response;
      }
      const entry = this.entries.get(canonical.key);
      if (!entry) {
        this.missing.push(canonical.key);
        return new Response('{"error":"fixture reply missing"}', {
          status: 412,
          headers: { "content-type": "application/json" },
        });
      }
      const reply = remapReply(entry.response, canonical.originals);
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  static async load(path: string, recording = false): Promise<FixtureReplies> {
    if (recording)
      return new FixtureReplies(path, true, { version: 1, entries: [] });
    const file = validateFile(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    return new FixtureReplies(path, recording, file);
  }

  /** Call after the full test succeeds; never commit a partial live capture. */
  async finish(): Promise<void> {
    if (this.missing.length)
      throw new Error(
        `Missing recorded TypeSafe request: ${[...new Set(this.missing)].join(", ")}. Run pnpm fixtures:record.`,
      );
    if (this.recording) {
      const entries = [...this.recorded.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      );
      const output = JSON.stringify({ version: 1, entries }, null, 2) + "\n";
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, output, { mode: 0o600 });
      await rename(temporary, this.path);
      return;
    }
    const unused = [...this.entries.keys()].filter(
      (key) => !this.used.has(key),
    );
    if (unused.length)
      throw new Error(`Unused recorded TypeSafe request: ${unused.join(", ")}`);
  }
}
