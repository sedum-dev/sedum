import {
  createCandidateNamesImplementation,
  type CandidateNameDependencies,
} from "./candidate-names-implementation.js";

export type { CandidateNameDependencies };

/** Candidate naming backed by the page bridge's flat-tree DOM primitives. */
export function createCandidateNames(dependencies: CandidateNameDependencies) {
  return createCandidateNamesImplementation(dependencies);
}
