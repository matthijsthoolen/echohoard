export type ConversationGroupingAction = "merge" | "unmerge";

export interface ConversationGroupingRequest {
  readonly archiveId: string;
  readonly targetConversationId: string;
  /** Exact owner-selected source ids. Order is not significant. */
  readonly sourceConversationIds: readonly string[];
  readonly expectedVersion: number;
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly ownerTitle?: string | null;
  readonly ownerAvatar?: string | null;
  readonly auditId?: string;
  readonly requestedAt?: Date;
}

export interface ConversationGroupingResult {
  readonly archiveId: string;
  readonly targetConversationId: string;
  readonly action: ConversationGroupingAction;
  readonly sourceConversationIds: readonly string[];
  readonly version: number;
  readonly auditId: string;
  readonly idempotent: boolean;
}

export interface ConversationGroupingPersistence {
  merge(request: ConversationGroupingRequest): Promise<ConversationGroupingResult>;
  unmerge(request: ConversationGroupingRequest): Promise<ConversationGroupingResult>;
  getState(archiveId: string, targetConversationId: string): Promise<ConversationGroupingState>;
}

export interface GroupingSourceConversation {
  readonly id: string;
  readonly title: string;
  readonly accountLabel: string;
  readonly sourceNamespace: string;
  readonly sourceConversationKey: string;
  readonly unifiedConversationId: string;
}

export interface ConversationGroupingState {
  readonly targetConversationId: string;
  readonly version: number;
  readonly sources: readonly GroupingSourceConversation[];
  readonly currentSourceIds: readonly string[];
  readonly mergeSourceIds: readonly string[];
  readonly mergeAuditId?: string;
}

export class ConversationGroupingService {
  public constructor(private readonly persistence: ConversationGroupingPersistence) {}

  public merge(request: ConversationGroupingRequest): Promise<ConversationGroupingResult> {
    validateRequest(request, false);
    return this.persistence.merge(request);
  }

  public unmerge(request: ConversationGroupingRequest): Promise<ConversationGroupingResult> {
    validateRequest(request, true);
    return this.persistence.unmerge(request);
  }

  public getState(
    archiveId: string,
    targetConversationId: string,
  ): Promise<ConversationGroupingState> {
    if (!archiveId.trim() || !targetConversationId.trim())
      throw new Error("conversation is required");
    return this.persistence.getState(archiveId, targetConversationId);
  }
}

function validateRequest(request: ConversationGroupingRequest, unmerge: boolean): void {
  for (const [name, value] of Object.entries(request)) {
    if (
      name === "requestedAt" ||
      name === "ownerTitle" ||
      name === "ownerAvatar" ||
      name === "sourceConversationIds"
    )
      continue;
    if (name === "expectedVersion") {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("expectedVersion is invalid");
    } else if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${name} is required`);
    }
  }
  if (!Array.isArray(request.sourceConversationIds) || request.sourceConversationIds.length === 0)
    throw new Error("sourceConversationIds must contain at least one exact id");
  const ids = new Set(request.sourceConversationIds);
  if (ids.size !== request.sourceConversationIds.length || ids.has(request.targetConversationId))
    throw new Error("sourceConversationIds must be unique and cannot contain the target");
  if (unmerge && !request.auditId) throw new Error("auditId is required for unmerge");
}
