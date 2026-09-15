import { randomUUID } from "node:crypto";

export const OWNER_DELETION_POLICY_VERSION = "eh-v2-04-01.v1";
export type OwnerDeletionEntity = "conversation" | "message" | "attachment";
export type OwnerDeletionAction = "delete" | "restore";

export interface OwnerDeletionRequest {
  readonly archiveId: string;
  readonly entityKind: OwnerDeletionEntity;
  readonly entityId: string;
  readonly action: OwnerDeletionAction;
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
  readonly requestedAt?: Date;
}

export interface OwnerDeletionResult {
  readonly archiveId: string;
  readonly entityKind: OwnerDeletionEntity;
  readonly entityId: string;
  readonly action: OwnerDeletionAction;
  readonly ownerDeleted: boolean;
  readonly version: number;
  readonly cascadeCount: number;
  readonly idempotent: boolean;
  readonly auditId: string;
  readonly policyVersion: typeof OWNER_DELETION_POLICY_VERSION;
}

export interface OwnerDeletionPersistence {
  execute(request: OwnerDeletionRequest): Promise<OwnerDeletionResult>;
}

export class OwnerDeletionConflictError extends Error {
  public readonly name = "OwnerDeletionConflictError";
  public constructor(
    readonly entityKind: OwnerDeletionEntity,
    readonly entityId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Owner deletion conflict for ${entityKind} ${entityId}: expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
  }
}

export class OwnerDeletionService {
  public constructor(private readonly persistence: OwnerDeletionPersistence) {}

  public execute(request: OwnerDeletionRequest): Promise<OwnerDeletionResult> {
    validate(request);
    return this.persistence.execute(request);
  }
}

export const newOwnerDeletionIdempotencyKey = (): string => randomUUID();

function validate(request: OwnerDeletionRequest): void {
  for (const [name, value] of Object.entries(request)) {
    if (name === "expectedVersion" || name === "requestedAt") continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  }
  if (!["conversation", "message", "attachment"].includes(request.entityKind))
    throw new Error("entityKind is invalid");
  if (!["delete", "restore"].includes(request.action)) throw new Error("action is invalid");
  if (
    request.expectedVersion !== undefined &&
    (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 0)
  )
    throw new Error("expectedVersion must be a non-negative integer");
}
