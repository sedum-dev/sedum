import type { BrowserPage } from "../browser-driver.js";
import { batches, sameVersion } from "./candidates.js";
import type { EliminationResult } from "./elimination.js";
import { ItemVerifier } from "./item-verifier.js";
import {
  codeAfterNone,
  itemQuestionGroup,
  lexicalMiss,
  nameStated,
  resolveBySection,
  resolveInCode,
  statedGroupPick,
} from "./lexical.js";
import {
  comparableLead,
  nearNamesake,
  repeatedGroup,
  repeatedMemberAccepted,
  roleOnlyAmbiguous,
  sentenceEvidence,
  topOptions,
} from "./policy.js";
import type {
  LocatorFailure,
  LocatorOptionDiagnostic,
  LocatorOptions,
  LocatorResult,
  RepeatedMemberPolicy,
} from "./types.js";
import { VisionFallback } from "./vision-fallback.js";
import { pageVersion } from "../page-bridge.js";
import type { Candidate, CandidatePage } from "../page-protocol.js";
import type { ResolverDecision } from "../provider.js";

const MIN_CONFIDENCE = 0.3;
const MIN_LEAD = 0.1;

export interface SelectionState {
  top: LocatorOptionDiagnostic[];
  confidence: number | null;
  gate?: string;
}

export interface RuntimeSelectionContext {
  readonly page: BrowserPage;
  readonly options: LocatorOptions;
  readonly source: CandidatePage;
  readonly elimination: EliminationResult;
  readonly state: SelectionState;
  readonly repeatedMember: RepeatedMemberPolicy;
  readonly verifyItems: boolean;
  readonly codeFallback: boolean;
  readonly itemVerifier: ItemVerifier;
  readonly vision: VisionFallback;
  readonly unresolved: (reason: LocatorFailure) => LocatorResult;
  readonly refresh: (candidate: Candidate) => Promise<LocatorResult>;
}

export class RuntimeSelection {
  private readonly candidates: readonly Candidate[];
  private readonly byId: ReadonlyMap<string, Candidate>;

  constructor(private readonly context: RuntimeSelectionContext) {
    this.candidates = context.source.candidates;
    this.byId = new Map(
      this.candidates.map((candidate) => [candidate.ref, candidate]),
    );
  }

  async resolve(): Promise<LocatorResult> {
    const { decision, finalists } = this.context.elimination;
    this.updateDecision(decision, finalists);
    if (decision.selection.kind === "none") return this.resolveNone();
    const selected = this.byId.get(decision.selection.id);
    if (!selected) return this.unresolved("provider_error");
    return this.resolveSelected(selected, decision, finalists);
  }

  private async resolveNone(): Promise<LocatorResult> {
    const { options, codeFallback } = this.context;
    const fallback = codeFallback
      ? codeAfterNone(options.sentence, this.candidates)
      : null;
    if (fallback) {
      this.gate("resolved_in_code_after_none");
      return this.accept(fallback);
    }
    if (!options.visionResolver || options.operation !== "click")
      return this.unresolved("none");
    this.gate("none");
    const seen = await this.ambiguous(this.candidates);
    return seen.kind === "unresolved" && seen.reason === "ambiguous"
      ? { ...seen, reason: "none" }
      : seen;
  }

  private async resolveSelected(
    selected: Candidate,
    decision: ResolverDecision,
    finalists: readonly Candidate[],
  ): Promise<LocatorResult> {
    const coded = this.codedTarget(selected);
    if (coded) return this.accept(coded.target, coded.gate);
    const verified = await this.verifiedItem(selected);
    if (verified) return this.accept(verified, "resolved_by_items");
    const group = repeatedGroup(selected, this.candidates);
    if (this.lowConfidence(decision, selected))
      return this.resolveLowConfidence(selected, group, decision);
    return this.resolveConfident(selected, group, decision, finalists);
  }

  private codedTarget(
    selected: Candidate,
  ): { target: Candidate; gate: string } | null {
    const { options, codeFallback } = this.context;
    const anchor =
      codeFallback && !nameStated(options.sentence, selected)
        ? (statedGroupPick(options.sentence, this.candidates) ?? selected)
        : selected;
    const inCode = (pick: Candidate) =>
      resolveInCode(options.sentence, pick, this.candidates) ??
      (codeFallback
        ? resolveInCode(options.sentence, anchor, this.candidates, true)
        : null);
    const section =
      options.sectionMatch !== false && !inCode(selected)
        ? resolveBySection(options.sentence, selected, this.candidates)
        : null;
    const target = section ?? inCode(selected);
    return target
      ? { target, gate: section ? "resolved_by_section" : "resolved_in_code" }
      : null;
  }

  private async verifiedItem(selected: Candidate): Promise<Candidate | null> {
    const { options, verifyItems, itemVerifier } = this.context;
    if (!verifyItems) return null;
    const anchor = nameStated(options.sentence, selected)
      ? selected
      : (statedGroupPick(options.sentence, this.candidates) ?? selected);
    const members = itemQuestionGroup(
      options.sentence,
      anchor,
      this.candidates,
    );
    return members ? itemVerifier.verify(members) : null;
  }

  private lowConfidence(
    decision: ResolverDecision,
    selected: Candidate,
  ): boolean {
    return (
      (decision.confidence !== null && decision.confidence < MIN_CONFIDENCE) ||
      comparableLead(decision, selected.ref) < MIN_LEAD
    );
  }

  private async resolveLowConfidence(
    selected: Candidate,
    group: readonly Candidate[],
    decision: ResolverDecision,
  ): Promise<LocatorResult> {
    const { options, repeatedMember } = this.context;
    if (group.length >= 2 && repeatedMember.modelPick) {
      this.gate("repeated_member_model_pick");
      return this.resolveConfident(
        selected,
        group,
        decision,
        this.context.elimination.finalists,
      );
    }
    if (group.length < 2 && options.acceptLowConfidence) {
      this.gate("low_confidence_accepted");
      return this.resolveConfident(
        selected,
        group,
        decision,
        this.context.elimination.finalists,
      );
    }
    this.gate("low_confidence_or_margin");
    if (group.length < 2) return this.unresolved("ambiguous");
    if (this.groupProbability(group, decision) < 0.75) {
      this.gate("repeated_group_weak");
      return this.ambiguous();
    }
    if (batches(options.sentence, group).length !== 1) return this.ambiguous();
    return this.narrowRepeatedGroup(group);
  }

  private groupProbability(
    group: readonly Candidate[],
    decision: ResolverDecision,
  ): number {
    return group.reduce(
      (sum, candidate) => sum + (decision.probabilities[candidate.ref] ?? 0),
      0,
    );
  }

  private async narrowRepeatedGroup(
    group: readonly Candidate[],
  ): Promise<LocatorResult> {
    if (await this.pageChanged()) return this.unresolved("stale");
    const decision = await this.context.elimination.choose(group);
    if (await this.pageChanged()) return this.unresolved("stale");
    this.updateDecision(decision, group);
    if (decision.selection.kind === "none") return this.unresolved("none");
    const member = this.byId.get(decision.selection.id);
    if (!member || !this.strongMember(member, decision)) {
      this.gate("repeated_member_weak");
      return this.ambiguous();
    }
    return this.acceptNarrowedMember(member, group, decision);
  }

  private strongMember(member: Candidate, decision: ResolverDecision): boolean {
    return (
      decision.probabilities[member.ref]! >= 0.6 &&
      comparableLead(decision, member.ref) >= 0.2
    );
  }

  private async acceptNarrowedMember(
    member: Candidate,
    group: readonly Candidate[],
    decision: ResolverDecision,
  ): Promise<LocatorResult> {
    if (!sentenceEvidence(this.context.options.sentence, member, group)) {
      const accepted = this.repeatedAcceptance(member, group, decision);
      if (!accepted) {
        this.gate("repeated_member_no_evidence");
        return this.ambiguous();
      }
      this.gate(accepted);
    }
    if (this.context.state.gate === "low_confidence_or_margin")
      this.gate("repeated_member_proven");
    return this.acceptWithRoleGate(member);
  }

  private async resolveConfident(
    selected: Candidate,
    group: readonly Candidate[],
    decision: ResolverDecision,
    finalists: readonly Candidate[],
  ): Promise<LocatorResult> {
    const evidence = await this.repeatedNameEvidence(selected, decision);
    if (evidence) return evidence;
    const gated = this.standardGate(selected, group, decision, finalists);
    return gated ?? this.context.refresh(selected);
  }

  private async repeatedNameEvidence(
    selected: Candidate,
    decision: ResolverDecision,
  ): Promise<LocatorResult | null> {
    const sameName = this.candidates.filter(
      (candidate) => this.masked(candidate.name) === this.masked(selected.name),
    );
    if (sameName.length < 2) return null;
    if (sentenceEvidence(this.context.options.sentence, selected, sameName))
      return null;
    const accepted = this.repeatedAcceptance(selected, sameName, decision);
    if (accepted) {
      this.gate(accepted);
      return null;
    }
    this.gate("repeated_member_no_evidence");
    return this.ambiguous(sameName);
  }

  private standardGate(
    selected: Candidate,
    group: readonly Candidate[],
    decision: ResolverDecision,
    finalists: readonly Candidate[],
  ): LocatorResult | null {
    if (this.notFillable(selected)) return this.unresolved("not_fillable");
    if (
      roleOnlyAmbiguous(
        this.context.options.sentence,
        selected,
        this.candidates,
      )
    )
      return this.gatedFailure("role_only_ambiguous");
    if (
      group.length < 2 &&
      nearNamesake(this.context.options.sentence, selected, finalists, decision)
    )
      return this.gatedFailure("near_namesake");
    if (lexicalMiss(this.context.options.sentence, selected, finalists))
      return this.gatedFailure("lexical_miss");
    return null;
  }

  private acceptWithRoleGate(
    candidate: Candidate,
  ): Promise<LocatorResult> | LocatorResult {
    if (this.notFillable(candidate)) return this.unresolved("not_fillable");
    if (
      roleOnlyAmbiguous(
        this.context.options.sentence,
        candidate,
        this.candidates,
      )
    )
      return this.gatedFailure("role_only_ambiguous");
    return this.context.refresh(candidate);
  }

  private accept(
    candidate: Candidate,
    gate?: string,
  ): Promise<LocatorResult> | LocatorResult {
    if (gate) this.gate(gate);
    return this.notFillable(candidate)
      ? this.unresolved("not_fillable")
      : this.context.refresh(candidate);
  }

  private repeatedAcceptance(
    member: Candidate,
    group: readonly Candidate[],
    decision: ResolverDecision,
  ) {
    return repeatedMemberAccepted({
      policy: this.context.repeatedMember,
      sentence: this.context.options.sentence,
      member,
      group,
      decision,
    });
  }

  private masked(name: string): string {
    return name
      .trim()
      .toLocaleLowerCase()
      .replace(/\d[\d.,]*[km]?(?=\s+\p{L})/gu, "#");
  }

  private notFillable(candidate: Candidate): boolean {
    return this.context.options.operation === "fill" && !candidate.editable;
  }

  private gatedFailure(gate: string): LocatorResult {
    this.gate(gate);
    return this.unresolved("ambiguous");
  }

  private ambiguous(
    members: readonly Candidate[] = repeatedGroupFallback,
  ): Promise<LocatorResult> {
    return this.context.vision.resolve(
      members === repeatedGroupFallback ? this.candidates : members,
    );
  }

  private async pageChanged(): Promise<boolean> {
    return !sameVersion(
      await pageVersion(this.context.page),
      this.context.source.version,
    );
  }

  private updateDecision(
    decision: ResolverDecision,
    candidates: readonly Candidate[],
  ): void {
    this.context.state.top = topOptions(decision, candidates, excerpt);
    this.context.state.confidence = decision.confidence;
  }

  private gate(value: string): void {
    this.context.state.gate = value;
  }

  private unresolved(reason: LocatorFailure): LocatorResult {
    return this.context.unresolved(reason);
  }
}

const repeatedGroupFallback: readonly Candidate[] = [];

function excerpt(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join("");
}
