import type { PersistenceRecord } from "./persistence.js";

export const MATERIALIZATION_POLICY_VERSION = "eh-13-06.v1";
export const MAX_EXCLUSION_PLAN_COUNT = 10_000;

export type ImportExclusionAction = "exclude" | "re-enable";
export type ImportEligibility = "eligible" | "excluded";
export type MaterializationRunStatus = "running" | "completed" | "failed";

export interface ImportExclusionRequest {
  readonly archiveId: string;
  readonly importJobId: string;
  readonly action: ImportExclusionAction;
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestedAt?: Date;
}

export interface ImportExclusionCounts {
  readonly conversations: number;
  readonly messages: number;
  readonly revisions: number;
  readonly reactions: number;
  readonly attachmentReferences: number;
  readonly observations: number;
}

export interface ImportExclusionPlan {
  readonly archiveId: string;
  readonly importJobId: string;
  readonly action: ImportExclusionAction;
  readonly currentEligibility: ImportEligibility;
  readonly nextEligibility: ImportEligibility;
  readonly counts: ImportExclusionCounts;
  readonly inputSetDigest: string;
  readonly truncated: boolean;
}

export interface ImportExclusionResult {
  readonly archiveId: string;
  readonly importJobId: string;
  readonly action: ImportExclusionAction;
  readonly runId: string;
  readonly status: "completed";
  readonly counts: ImportExclusionCounts;
  readonly inputSetDigest: string;
  readonly idempotent: boolean;
}

export interface ImportExclusionPersistence {
  plan(request: ImportExclusionRequest): Promise<ImportExclusionPlan>;
  apply(request: ImportExclusionRequest): Promise<ImportExclusionResult>;
}

export type ImportExclusionPort = ImportExclusionPersistence;

export class PlanImportExclusionService {
  public constructor(private readonly persistence: ImportExclusionPersistence) {}

  public execute(request: ImportExclusionRequest): Promise<ImportExclusionPlan> {
    validateRequest(request);
    return this.persistence.plan(request);
  }
}

export class ApplyImportExclusionService {
  public constructor(private readonly persistence: ImportExclusionPersistence) {}

  public execute(request: ImportExclusionRequest): Promise<ImportExclusionResult> {
    validateRequest(request);
    return this.persistence.apply(request);
  }
}

export function transitionMaterializationRun(
  status: MaterializationRunStatus,
  next: MaterializationRunStatus,
): MaterializationRunStatus {
  const transitions: Record<MaterializationRunStatus, readonly MaterializationRunStatus[]> = {
    running: ["completed", "failed"],
    failed: ["running"],
    completed: ["completed"],
  };
  if (!transitions[status].includes(next))
    throw new Error(`Invalid materialization run transition: ${status} -> ${next}`);
  return next;
}

export interface MaterializationObservation {
  readonly observationKey: string;
  readonly observedAt: Date;
  readonly sourceKind: string;
  readonly value: PersistenceRecord | null;
}

/**
 * ADR-0002's field-level precedence. Callers provide the field usability
 * predicate because the application contract deliberately does not know the
 * source adapter's value shape.
 */
export function selectPreferredObservation(
  observations: readonly MaterializationObservation[],
  isUsable: (value: PersistenceRecord | null) => boolean,
): MaterializationObservation | undefined {
  return observations.reduce<MaterializationObservation | undefined>((winner, candidate) => {
    if (!winner) return candidate;
    const candidateUsable = isUsable(candidate.value);
    const winnerUsable = isUsable(winner.value);
    if (candidateUsable !== winnerUsable) return candidateUsable ? candidate : winner;
    const candidateBackup = candidate.sourceKind !== "live";
    const winnerBackup = winner.sourceKind !== "live";
    if (candidateBackup !== winnerBackup) return candidateBackup ? candidate : winner;
    const timeDifference = candidate.observedAt.getTime() - winner.observedAt.getTime();
    if (timeDifference !== 0) return timeDifference > 0 ? candidate : winner;
    return candidate.observationKey > winner.observationKey ? candidate : winner;
  }, undefined);
}

function validateRequest(request: ImportExclusionRequest): void {
  for (const [name, value] of Object.entries(request)) {
    if (name === "requestedAt") continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  }
  if (request.action !== "exclude" && request.action !== "re-enable")
    throw new Error("action must be exclude or re-enable");
}
