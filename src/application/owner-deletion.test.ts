import { describe, expect, it } from "vitest";
import {
  OwnerDeletionConflictError,
  OwnerDeletionService,
  type OwnerDeletionPersistence,
  type OwnerDeletionRequest,
  type OwnerDeletionResult,
} from "./owner-deletion.js";

const request: OwnerDeletionRequest = {
  archiveId: "archive",
  entityKind: "message",
  entityId: "message",
  action: "delete",
  actor: "owner",
  reason: "requested by owner",
  idempotencyKey: "request-1",
};

describe("OwnerDeletionService", () => {
  it("validates the single audited command contract", async () => {
    const calls: OwnerDeletionRequest[] = [];
    const persistence: OwnerDeletionPersistence = {
      execute: async (value) => {
        calls.push(value);
        return {
          archiveId: value.archiveId,
          entityKind: value.entityKind,
          entityId: value.entityId,
          action: value.action,
          ownerDeleted: value.action === "delete",
          version: 1,
          cascadeCount: 0,
          idempotent: false,
          auditId: "audit",
          policyVersion: "eh-v2-04-01.v1",
        } as OwnerDeletionResult;
      },
    };
    const result = await new OwnerDeletionService(persistence).execute(request);
    expect(result.ownerDeleted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("exposes explicit concurrency conflicts from persistence", async () => {
    const persistence: OwnerDeletionPersistence = {
      execute: async () => {
        throw new OwnerDeletionConflictError("conversation", "conversation", 2, 3);
      },
    };
    await expect(
      new OwnerDeletionService(persistence).execute({
        ...request,
        entityKind: "conversation",
        entityId: "conversation",
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(OwnerDeletionConflictError);
  });

  it.each(["", "   "])("rejects an empty reason (%j)", async (reason) => {
    const persistence: OwnerDeletionPersistence = {
      execute: async () => {
        throw new Error("unreachable");
      },
    };
    expect(() => new OwnerDeletionService(persistence).execute({ ...request, reason })).toThrow(
      "reason is required",
    );
  });
});
