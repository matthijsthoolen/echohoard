import { describe, expect, it, vi } from "vitest";
import {
  ConversationGroupingService,
  type ConversationGroupingPersistence,
} from "./conversation-grouping.js";

const request = {
  archiveId: "archive",
  targetConversationId: "target",
  sourceConversationIds: ["source-a", "source-b"],
  expectedVersion: 0,
  actor: "owner",
  reason: "same chat",
  idempotencyKey: "command-1",
} as const;

describe("ConversationGroupingService", () => {
  it("passes an exact merge command to the archive-scoped port", async () => {
    const persistence: ConversationGroupingPersistence = {
      merge: vi.fn().mockResolvedValue({
        archiveId: request.archiveId,
        targetConversationId: request.targetConversationId,
        action: "merge",
        sourceConversationIds: request.sourceConversationIds,
        version: 1,
        auditId: "audit",
        idempotent: false,
      }),
      unmerge: vi.fn(),
      getState: vi.fn(),
    };
    await expect(
      new ConversationGroupingService(persistence).merge(request),
    ).resolves.toMatchObject({
      action: "merge",
      auditId: "audit",
    });
    expect(persistence.merge).toHaveBeenCalledWith(request);
  });

  it.each([
    ["empty source selection", { sourceConversationIds: [] }],
    ["target selected as source", { sourceConversationIds: ["target"] }],
    ["duplicate source selection", { sourceConversationIds: ["source-a", "source-a"] }],
  ])("rejects %s before persistence", async (_label, change) => {
    const persistence: ConversationGroupingPersistence = {
      merge: vi.fn(),
      unmerge: vi.fn(),
      getState: vi.fn(),
    };
    expect(() =>
      new ConversationGroupingService(persistence).merge({ ...request, ...change }),
    ).toThrow();
    expect(persistence.merge).not.toHaveBeenCalled();
  });

  it("requires the audit that makes unmerge reversible", async () => {
    const persistence: ConversationGroupingPersistence = {
      merge: vi.fn(),
      unmerge: vi.fn(),
      getState: vi.fn(),
    };
    expect(() => new ConversationGroupingService(persistence).unmerge(request)).toThrow(
      "auditId is required",
    );
  });
});
