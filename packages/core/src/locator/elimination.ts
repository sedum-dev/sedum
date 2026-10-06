import type { BrowserPage } from "../browser-driver.js";
import { pageVersion } from "../page-bridge.js";
import {
  CANDIDATE_LIMIT,
  projectCandidates,
  type Candidate,
  type CandidatePage,
} from "../page-protocol.js";
import {
  unknownCostCall,
  type ProviderCall,
  type Resolver,
  type ResolverDecision,
} from "../provider.js";
import { inNamedRegion } from "./lexical.js";
import { LocatorError } from "./error.js";
import {
  batches,
  hintedCandidate,
  requestOptions,
  sameVersion,
  withSiblings,
} from "./candidates.js";
import { validateDecision } from "./policy.js";
import type { LocatorOptions } from "./types.js";

const MAX_PARALLEL_CHOICES = 4;

interface EliminationContext {
  readonly page: BrowserPage;
  readonly resolver: Resolver;
  readonly options: LocatorOptions;
  readonly source: CandidatePage;
  readonly calls: ProviderCall[];
  readonly signal: AbortSignal;
  readonly ensureActive: () => void;
  readonly roundCompleted: () => void;
}

export interface EliminationResult {
  readonly decision: ResolverDecision;
  readonly finalists: Candidate[];
  readonly stale: boolean;
  readonly choose: (pool: readonly Candidate[]) => Promise<ResolverDecision>;
}

async function choose(
  context: EliminationContext,
  pool: readonly Candidate[],
): Promise<ResolverDecision> {
  const { resolver, options, calls, signal, ensureActive, roundCompleted } =
    context;
  ensureActive();
  const projected = projectCandidates(
    requestOptions(
      options.nameHints === false ? pool : pool.map(hintedCandidate),
    ),
  );
  const decision = await resolver
    .choose(
      options.sentence,
      {
        complete: true,
        options: [
          ...projected.map((candidate) => ({
            kind: "candidate" as const,
            candidate: options.projectText
              ? {
                  ...candidate,
                  name: options.projectText(candidate.name),
                  peers: candidate.peers.map(options.projectText),
                  ...(candidate.location
                    ? { location: options.projectText(candidate.location) }
                    : {}),
                }
              : candidate,
          })),
          { kind: "none" as const, id: "none" as const },
        ],
      },
      { signal },
    )
    .catch((error: unknown) => {
      calls.push(unknownCostCall(error));
      throw error;
    });
  calls.push(decision.call);
  ensureActive();
  validateDecision(decision, pool);
  roundCompleted();
  return decision;
}

function picksFromHeats(
  heats: readonly Candidate[][],
  choices: readonly ResolverDecision[],
): Candidate[] {
  return heats.flatMap((heat, index) =>
    heat
      .filter((candidate) => candidate.ref !== "none")
      .sort(
        (a, b) =>
          choices[index]!.probabilities[b.ref]! -
          choices[index]!.probabilities[a.ref]!,
      )
      .slice(0, 2),
  );
}

async function reduceHeats(
  context: EliminationContext,
  heats: Candidate[][],
): Promise<Candidate[]> {
  const reduced: Candidate[] = [];
  for (let index = 0; index < heats.length; index += MAX_PARALLEL_CHOICES) {
    context.ensureActive();
    const group = heats.slice(index, index + MAX_PARALLEL_CHOICES);
    const settled = await Promise.allSettled(
      group.map((batch) => choose(context, batch)),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const choices = settled.map(
      (result) => (result as PromiseFulfilledResult<ResolverDecision>).value,
    );
    if (!sameVersion(await pageVersion(context.page), context.source.version))
      throw new LocatorError("stale");
    reduced.push(...picksFromHeats(group, choices));
  }
  return reduced;
}

export async function eliminateCandidates(
  context: EliminationContext,
): Promise<EliminationResult> {
  const { options, source } = context;
  const candidates = source.candidates;
  let pool =
    candidates.length > CANDIDATE_LIMIT
      ? inNamedRegion(options.sentence, candidates)
      : [...candidates];
  let reducedAcrossBatches = false;
  while (true) {
    const heats = batches(options.sentence, pool);
    if (heats.length === 1) {
      const finalists = reducedAcrossBatches
        ? withSiblings(options.sentence, heats[0]!, candidates)
        : heats[0]!;
      const decision = await choose(context, finalists);
      const stale =
        reducedAcrossBatches &&
        !sameVersion(await pageVersion(context.page), source.version);
      return {
        decision,
        finalists,
        stale,
        choose: (pool) => choose(context, pool),
      };
    }
    reducedAcrossBatches = true;
    const reduced = await reduceHeats(context, heats);
    if (reduced.length >= pool.length) throw new LocatorError("resource_limit");
    pool = reduced;
  }
}
