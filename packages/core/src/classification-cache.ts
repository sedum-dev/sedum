import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
  ACCEPTANCE_POLICY_VERSION,
  MODEL_CHOICES,
  OPERATION_SET_VERSION,
  OPERATIONS,
  canonicalSentence,
  evaluateModelAnswer,
  type CachedClassification,
  type CacheLookup,
  type ClassificationCache,
  type ModelChoice,
  type StepOperationKind,
} from "./classification.js";

const FORMAT_VERSION = 1;
export const CLASSIFICATION_PROMPT_VERSION = 1;
const KEY_DOMAIN = "sedum-classification-v1\0";

interface Entry extends CachedClassification {
  readonly source: "model";
  readonly promptVersion: number;
  readonly operationSetVersion: number;
  readonly acceptancePolicyVersion: number;
}
interface CacheFile {
  readonly version: number;
  readonly entries: Readonly<Record<string, Entry>>;
}

export function classificationKey(sentence: string): string {
  return createHash("sha256")
    .update(KEY_DOMAIN)
    .update(canonicalSentence(sentence))
    .digest("hex");
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (
    entry.source !== "model" ||
    !OPERATIONS.includes(entry.op as StepOperationKind) ||
    typeof entry.model !== "string" ||
    !entry.model ||
    typeof entry.requestedModel !== "string" ||
    !entry.requestedModel ||
    entry.promptVersion !== CLASSIFICATION_PROMPT_VERSION ||
    entry.operationSetVersion !== OPERATION_SET_VERSION ||
    entry.acceptancePolicyVersion !== ACCEPTANCE_POLICY_VERSION ||
    !entry.probabilities ||
    typeof entry.probabilities !== "object"
  )
    return false;
  const decision = evaluateModelAnswer({
    op: entry.op as StepOperationKind,
    probabilities: entry.probabilities as Readonly<Record<ModelChoice, number>>,
    model: entry.model,
    requestedModel: entry.requestedModel,
  });
  return decision.accepted;
}

/** A committable, sentence-only cache. It contains no raw sentence or runtime value. */
export class FileClassificationCache implements ClassificationCache {
  private readonly entries: Record<string, Entry>;
  private dirty = false;
  private constructor(
    readonly path: string,
    readonly requestedModel: string,
    entries: Record<string, Entry>,
    readonly loadReason: "ok" | "absent" | "corrupt" | "format_mismatch",
    private readonly invalidKeys: Readonly<Record<string, string>>,
  ) {
    this.entries = entries;
  }

  static async load(
    path: string,
    requestedModel: string,
  ): Promise<FileClassificationCache> {
    try {
      const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return new FileClassificationCache(
          path,
          requestedModel,
          {},
          "corrupt",
          {},
        );
      const file = value as Partial<CacheFile>;
      if (file.version !== FORMAT_VERSION)
        return new FileClassificationCache(
          path,
          requestedModel,
          {},
          "format_mismatch",
          {},
        );
      if (
        !file.entries ||
        typeof file.entries !== "object" ||
        Array.isArray(file.entries)
      )
        return new FileClassificationCache(
          path,
          requestedModel,
          {},
          "corrupt",
          {},
        );
      const entries: Record<string, Entry> = Object.create(null) as Record<
        string,
        Entry
      >;
      const invalidKeys: Record<string, string> = Object.create(null) as Record<
        string,
        string
      >;
      for (const [key, entry] of Object.entries(file.entries)) {
        if (!/^[0-9a-f]{64}$/u.test(key)) continue;
        if (validEntry(entry)) entries[key] = entry;
        else invalidKeys[key] = "invalid_or_incompatible";
      }
      return new FileClassificationCache(
        path,
        requestedModel,
        entries,
        "ok",
        invalidKeys,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return new FileClassificationCache(
          path,
          requestedModel,
          {},
          "absent",
          {},
        );
      return new FileClassificationCache(
        path,
        requestedModel,
        {},
        "corrupt",
        {},
      );
    }
  }

  get(sentence: string): CacheLookup {
    const entry = this.entries[classificationKey(sentence)];
    if (!entry)
      return {
        answer: null,
        reason:
          this.invalidKeys[classificationKey(sentence)] ??
          (this.loadReason === "ok" ? "absent" : this.loadReason),
      };
    if (entry.requestedModel !== this.requestedModel)
      return { answer: null, reason: "model_mismatch" };
    // Reapply the current gate even if the entry was valid on load.
    const decision = evaluateModelAnswer(entry);
    if (!decision.accepted)
      return { answer: null, reason: "acceptance_policy" };
    return { answer: entry, reason: "hit" };
  }

  put(sentence: string, answer: CachedClassification): void {
    if (
      !OPERATIONS.includes(answer.op) ||
      answer.requestedModel !== this.requestedModel ||
      !evaluateModelAnswer(answer).accepted
    )
      throw new Error("Cannot cache an invalid classification");
    const probabilities = Object.fromEntries(
      MODEL_CHOICES.map((key) => [key, answer.probabilities[key]]),
    ) as Record<ModelChoice, number>;
    this.entries[classificationKey(sentence)] = {
      op: answer.op,
      probabilities,
      model: answer.model,
      requestedModel: answer.requestedModel,
      source: "model",
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      operationSetVersion: OPERATION_SET_VERSION,
      acceptancePolicyVersion: ACCEPTANCE_POLICY_VERSION,
    };
    this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(dirname(this.path), { recursive: true });
    const lock = this.path + ".lock";
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        handle = await fs.open(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - (await fs.stat(lock)).mtimeMs > 30_000)
            await fs.rm(lock, { force: true });
        } catch {
          /* Another writer released the lock. */
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!handle) throw new Error("Classification cache is busy");
    try {
      // Merge changes made since this instance loaded, under the lock.
      const latest = await FileClassificationCache.load(
        this.path,
        this.requestedModel,
      );
      const merged = { ...latest.entries, ...this.entries };
      const sorted = Object.fromEntries(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      );
      const body =
        JSON.stringify({ version: FORMAT_VERSION, entries: sorted }, null, 2) +
        "\n";
      const temp = this.path + "." + randomBytes(8).toString("hex") + ".tmp";
      try {
        await fs.writeFile(temp, body, { mode: 0o600, flag: "wx" });
        await fs.rename(temp, this.path);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      Object.assign(this.entries, merged);
      this.dirty = false;
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
  }
}

export class NoopClassificationCache implements ClassificationCache {
  get(): CacheLookup {
    return { answer: null, reason: "disabled" };
  }
  put(): void {
    /* deliberately ignored */
  }
  async save(): Promise<void> {
    /* deliberately ignored */
  }
}
