import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../application/auth";
import { createPrivacyRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "owner-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};

describe("privacy route", () => {
  it("does not enumerate locked policy details before step-up", async () => {
    const list = vi.fn(async () => [
      {
        archiveId: "archive-1",
        conversationId: "chat-1",
        uiVisibility: "locked" as const,
        mcpAccess: "denied" as const,
        sourceLockMetadata: { title: "must not cross this boundary" },
      },
    ]);
    const route = createPrivacyRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        conversationPrivacy: { list, updatePolicy: vi.fn() },
      }),
    });

    const response = await route(new Request("http://localhost/api/privacy"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      policies: [],
      lockedFolder: { available: true, unlocked: false },
    });
    expect(list).toHaveBeenCalledWith("archive-1");
  });

  it("updates only the authenticated archive and actor", async () => {
    const updatePolicy = vi.fn(async (request: Record<string, unknown>) => ({
      policy: {
        archiveId: request.archiveId,
        conversationId: request.conversationId,
        uiVisibility: request.uiVisibility,
        mcpAccess: request.mcpAccess,
      },
      audit: [],
    }));
    const route = createPrivacyRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        conversationPrivacy: {
          list: vi.fn(async () => [
            {
              archiveId: "archive-1",
              conversationId: "chat-1",
              uiVisibility: "normal",
              mcpAccess: "allowed",
            },
          ]),
          updatePolicy,
        },
      }),
    });

    const response = await route(
      new Request("http://localhost/api/privacy", {
        method: "PATCH",
        body: JSON.stringify({
          conversationId: "chat-1",
          uiVisibility: "hidden",
          mcpAccess: "denied",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(updatePolicy).toHaveBeenCalledWith({
      archiveId: "archive-1",
      conversationId: "chat-1",
      actorId: "owner-1",
      uiVisibility: "hidden",
      mcpAccess: "denied",
    });
  });

  it("returns locked policies only after the server-side grant is valid", async () => {
    const route = createPrivacyRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => principal,
          grantedConversationIds: vi.fn(async () => ["chat-1", "chat-2"]),
        },
        conversationPrivacy: {
          list: vi.fn(async () => [
            {
              archiveId: "archive-1",
              conversationId: "chat-1",
              uiVisibility: "locked",
              mcpAccess: "denied",
            },
            {
              archiveId: "archive-1",
              conversationId: "chat-2",
              uiVisibility: "locked",
              mcpAccess: "allowed",
            },
          ]),
          updatePolicy: vi.fn(),
        },
      }),
    });
    const response = await route(new Request("http://localhost/api/privacy"));
    expect(await response.json()).toEqual({
      policies: [
        {
          archiveId: "archive-1",
          conversationId: "chat-1",
          uiVisibility: "locked",
          mcpAccess: "denied",
        },
        {
          archiveId: "archive-1",
          conversationId: "chat-2",
          uiVisibility: "locked",
          mcpAccess: "allowed",
        },
      ],
      lockedFolder: { available: true, unlocked: true },
    });
  });

  it("does not resolve an unknown unlock handle into a conversation identifier", async () => {
    const updatePolicy = vi.fn();
    const route = createPrivacyRoute({
      getRuntime: () => ({
        auth: {
          principalForRequest: async () => principal,
          resolveUnlockHandle: vi.fn(async () => null),
        },
        conversationPrivacy: { list: vi.fn(), updatePolicy },
      }),
    });
    const response = await route(
      new Request("http://localhost/api/privacy", {
        method: "PATCH",
        body: JSON.stringify({ unlockHandle: "not-a-valid-handle", uiVisibility: "normal" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(updatePolicy).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("not-a-valid-handle");
  });

  it("fails closed and sanitizes update errors", async () => {
    const route = createPrivacyRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        conversationPrivacy: {
          list: vi.fn(),
          updatePolicy: vi.fn(async () => {
            throw new Error("chat title");
          }),
        },
      }),
    });
    const response = await route(
      new Request("http://localhost/api/privacy", { method: "PATCH", body: "{}" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Privacy settings unavailable" });
  });
});
