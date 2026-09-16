import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../../../application/auth";
import type { ConversationGroupingPersistence } from "../../../../../../../application/conversation-grouping";
import { ConversationGroupingService } from "../../../../../../../application/conversation-grouping";
import { createGroupingRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "owner",
  archiveId: "archive-1",
  issuer: "issuer",
  subject: "owner",
};

describe("conversation grouping route", () => {
  it("authenticates and forwards exact selected source chats", async () => {
    const merge = vi.fn(async () => ({
      archiveId: "archive-1",
      targetConversationId: "target",
      action: "merge" as const,
      sourceConversationIds: ["source"],
      version: 1,
      auditId: "audit",
      idempotent: false,
    }));
    const persistence: ConversationGroupingPersistence = {
      merge,
      unmerge: vi.fn(),
      getState: vi.fn(),
    };
    const route = createGroupingRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        grouping: new ConversationGroupingService(persistence),
      }),
    });
    const response = await route(
      new Request("http://localhost/api/conversations/target/grouping", {
        method: "POST",
        body: JSON.stringify({
          action: "merge",
          sourceConversationIds: ["source"],
          expectedVersion: 0,
        }),
      }),
      { params: { conversationId: "target" } },
    );
    expect(response.status).toBe(200);
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveId: "archive-1",
        targetConversationId: "target",
        sourceConversationIds: ["source"],
        actor: "owner",
      }),
    );
  });

  it("returns a conflict without leaking persistence details", async () => {
    const persistence: ConversationGroupingPersistence = {
      merge: vi.fn(async () => {
        throw new Error("stale grouping version");
      }),
      unmerge: vi.fn(),
      getState: vi.fn(),
    };
    const route = createGroupingRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        grouping: new ConversationGroupingService(persistence),
      }),
    });
    const response = await route(
      new Request("http://localhost/api/conversations/target/grouping", {
        method: "POST",
        body: JSON.stringify({
          action: "merge",
          sourceConversationIds: ["source"],
          expectedVersion: 0,
        }),
      }),
      { params: { conversationId: "target" } },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Conversation changed; reload before retrying",
    });
  });

  it("re-reads durable grouping state for reload and conflict recovery", async () => {
    const getState = vi.fn(async () => ({
      targetConversationId: "target",
      version: 3,
      sources: [
        {
          id: "source-exact",
          title: "chat-key",
          accountLabel: "Account A",
          sourceNamespace: "backup",
          sourceConversationKey: "chat-key",
          unifiedConversationId: "target",
        },
      ],
      currentSourceIds: ["source-exact"],
      mergeSourceIds: [],
    }));
    const persistence: ConversationGroupingPersistence = {
      merge: vi.fn(),
      unmerge: vi.fn(),
      getState,
    };
    const route = createGroupingRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        grouping: new ConversationGroupingService(persistence),
      }),
    });
    const response = await route(
      new Request("http://localhost/api/conversations/target/grouping"),
      { params: { conversationId: "target" } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 3,
      sources: [{ id: "source-exact" }],
    });
    expect(getState).toHaveBeenCalledWith("archive-1", "target", {
      authorizedConversationIds: [],
    });
  });

  it("passes recent step-up grants for every grouping id without enumerating denied ids", async () => {
    const getState = vi.fn(async () => {
      throw new Error("grouping conversation unavailable");
    });
    const persistence: ConversationGroupingPersistence = {
      merge: vi.fn(async () => {
        throw new Error("grouping conversation unavailable");
      }),
      unmerge: vi.fn(),
      getState,
    };
    const lockedPrincipal = vi.fn(async (_request: Request, _archive: string, id: string) =>
      id === "locked-source" ? principal : null,
    );
    const route = createGroupingRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal, lockedPrincipal },
        grouping: new ConversationGroupingService(persistence),
      }),
    });
    const response = await route(
      new Request("http://localhost/api/conversations/target/grouping", {
        method: "POST",
        body: JSON.stringify({
          action: "merge",
          sourceConversationIds: ["locked-source", "missing-source"],
          expectedVersion: 0,
        }),
      }),
      { params: { conversationId: "target" } },
    );
    expect(response.status).toBe(404);
    expect(lockedPrincipal).toHaveBeenCalledTimes(3);
    expect(getState).not.toHaveBeenCalled();
  });
});
