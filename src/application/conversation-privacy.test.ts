import { describe, expect, it, vi } from "vitest";
import {
  UpdateConversationPrivacyService,
  transitionConversationPrivacy,
  type ConversationPrivacyPolicy,
} from "./conversation-privacy.js";

const policy: ConversationPrivacyPolicy = {
  archiveId: "archive-a",
  conversationId: "conversation-a",
  uiVisibility: "normal",
  mcpAccess: "allowed",
  sourceLockMetadata: { locked: true },
};

describe("conversation privacy policy", () => {
  it("keeps every UI state and MCP access orthogonal", () => {
    expect(
      transitionConversationPrivacy(policy, {
        archiveId: "archive-a",
        conversationId: "conversation-a",
        actorId: "user-a",
        uiVisibility: "locked",
        mcpAccess: "denied",
      }),
    ).toMatchObject({
      uiVisibility: "locked",
      mcpAccess: "denied",
      sourceLockMetadata: { locked: true },
    });
  });

  it("rejects cross-archive transitions and empty updates", () => {
    expect(() =>
      transitionConversationPrivacy(policy, {
        archiveId: "archive-b",
        conversationId: "conversation-a",
        actorId: "user-a",
        uiVisibility: "hidden",
      }),
    ).toThrow("archive-scoped");
    const service = new UpdateConversationPrivacyService({
      updatePolicy: vi.fn(),
      findPolicy: vi.fn(),
    });
    expect(() => service.execute({ archiveId: "a", conversationId: "c", actorId: "u" })).toThrow(
      "At least one privacy policy field is required",
    );
  });

  it("delegates audited mutation without exposing content fields", async () => {
    const updatePolicy = vi.fn().mockResolvedValue({ policy, audit: [] });
    const service = new UpdateConversationPrivacyService({ updatePolicy, findPolicy: vi.fn() });
    await service.execute({
      archiveId: "archive-a",
      conversationId: "conversation-a",
      actorId: "user-a",
      mcpAccess: "denied",
    });
    expect(updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ mcpAccess: "denied" }));
    expect(updatePolicy.mock.calls[0]?.[0]).not.toHaveProperty("title");
  });
});
