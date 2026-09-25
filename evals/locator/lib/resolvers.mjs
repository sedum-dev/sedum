import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NO_COST_CALL = {
  requestedModel: "lexical",
  model: "lexical",
  attempts: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

const STOP_WORDS = new Set(
  "a an and at click for from in into of on the to type with".split(" "),
);

function words(text) {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !STOP_WORDS.has(word),
  );
}

/**
 * A key-free baseline: word overlap between the sentence and each
 * candidate's name and peers, softened into a distribution. It exists so the
 * harness runs without a provider and gives a floor to compare against.
 */
export function lexicalResolver() {
  return {
    async choose(sentence, candidates) {
      const wanted = new Set(words(sentence.replace(/\{\{[^}]*\}\}/gu, "")));
      const scores = {};
      for (const option of candidates.options) {
        if (option.kind === "none") {
          scores.none = 1;
          continue;
        }
        const { id, name, peers, role } = option.candidate;
        const hits = (text) => words(text).filter((w) => wanted.has(w)).length;
        const nameWords = words(name);
        const nameHits = hits(name);
        scores[id] =
          2 * nameHits +
          (nameWords.length > 0 && nameHits === nameWords.length ? 1 : 0) +
          0.5 * peers.reduce((sum, peer) => sum + hits(peer), 0) +
          (wanted.has(role) ? 0.5 : 0);
      }
      const exp = Object.fromEntries(
        Object.entries(scores).map(([id, score]) => [id, Math.exp(score)]),
      );
      const total = Object.values(exp).reduce((sum, value) => sum + value, 0);
      const probabilities = Object.fromEntries(
        Object.entries(exp).map(([id, value]) => [id, value / total]),
      );
      const best = Object.keys(probabilities).reduce((a, b) =>
        probabilities[b] > probabilities[a] ? b : a,
      );
      return {
        selection:
          best === "none" ? { kind: "none" } : { kind: "candidate", id: best },
        probabilities,
        confidence: null,
        call: NO_COST_CALL,
      };
    },
  };
}

/**
 * Candidate ids are random per page load, so the cache key replaces them with
 * their position. The provider still receives the original request; replies
 * are stored by position and mapped back on a hit, making reruns and gate
 * sweeps free and reproducible without a key.
 */
export function cachedResolver(inner, file, { model, offline = false } = {}) {
  const store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const keyOf = (sentence, candidates) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          model,
          sentence,
          options: candidates.options.map((option) =>
            option.kind === "none"
              ? "none"
              : { ...option.candidate, id: undefined },
          ),
        }),
      )
      .digest("hex");
  const ids = (candidates) =>
    candidates.options.map((option) =>
      option.kind === "none" ? "none" : option.candidate.id,
    );
  return {
    hits: 0,
    misses: 0,
    async choose(sentence, candidates, options) {
      const key = keyOf(sentence, candidates);
      const current = ids(candidates);
      const saved = store[key];
      if (saved) {
        this.hits++;
        const probabilities = Object.fromEntries(
          saved.probabilities.map((value, index) => [current[index], value]),
        );
        return {
          selection:
            saved.selection === -1
              ? { kind: "none" }
              : { kind: "candidate", id: current[saved.selection] },
          probabilities,
          confidence: saved.confidence,
          // Report the recorded usage so cost metrics describe the strategy.
          call: saved.call,
        };
      }
      if (offline) throw new Error(`No recorded reply for ${key}`);
      this.misses++;
      const decision = await inner.choose(sentence, candidates, options);
      store[key] = {
        sentence,
        probabilities: current.map((id) => decision.probabilities[id]),
        selection:
          decision.selection.kind === "none"
            ? -1
            : current.indexOf(decision.selection.id),
        confidence: decision.confidence,
        call: decision.call,
      };
      return decision;
    },
    save() {
      const sorted = Object.fromEntries(
        Object.entries(store).sort(([a], [b]) => a.localeCompare(b)),
      );
      writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
    },
  };
}
