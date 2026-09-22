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

function canonicalize(body: string): CanonicalRequest {
  const request = object(JSON.parse(body) as unknown);
  if (
    Object.keys(request).sort().join(",") !== "model,questions,state" ||
    request.model !== "jev-latest"
  )
    throw new Error("Unexpected fixture provider request fields");
  const state = object(request.state);
  const questions = object(request.questions);
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
  } else if (
    Object.keys(state).length !== 0 ||
    !questionKeys.every((key) => /^line\d+$/u.test(key))
  )
    throw new Error("Unexpected fixture classification request");
  const aliases = new Map<string, string>();
  const originals = new Map<string, string>();
  if (Object.hasOwn(questions, "target")) {
    const target = object(questions.target);
    const criteria = object(target.criteria);
    const normalized: Record<string, unknown> = {};
    let index = 0;
    for (const [id, description] of Object.entries(criteria)) {
      const alias = id === "none" ? "none" : `candidate_${index++}`;
      if (aliases.has(id) || originals.has(alias))
        throw new Error("Duplicate fixture candidate ID");
      aliases.set(id, alias);
      originals.set(alias, id);
      normalized[alias] = description;
    }
    questions.target = { ...target, criteria: normalized };
  }
  if (
    JSON.stringify(state).includes("http://") ||
    JSON.stringify(state).includes("https://")
  )
    throw new Error("External URL in fixture provider request");
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
    const response = object(entry.response);
    if (Object.keys(response).sort().join(",") !== "answers,model,usage")
      throw new Error("Fixture reply contains unexpected response fields");
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
        const normalized = remapReply(
          { answers: raw.answers, model: raw.model, usage: raw.usage },
          canonical.aliases,
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
