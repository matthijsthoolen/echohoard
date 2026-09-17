import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OidcAuth, type OidcProvider } from "../../src/application/auth.js";
import { createConversationsRoute } from "../../src/delivery/web/app/api/conversations/route-handler.js";
import { createPrivacyRoute } from "../../src/delivery/web/app/api/privacy/route-handler.js";
import { hashToken, PrismaSessionStore } from "../../src/infrastructure/auth/sessions.js";
import { PrismaUnlockStore } from "../../src/infrastructure/auth/unlocks.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const otherArchiveId = randomUUID();
const lockedConversationId = randomUUID();
const principal = {
  userId,
  archiveId,
  issuer: "https://issuer.example.test",
  subject: "durable-session-owner",
  role: "admin" as const,
};
const provider: OidcProvider = {
  authorizationUrl: () => "https://issuer.example.test/authorize",
  exchange: async () => ({}),
};

describe("PostgreSQL durable auth sessions", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.createMany({
      data: [
        { id: archiveId, userId, name: "Durable sessions" },
        { id: otherArchiveId, userId, name: "Other archive" },
      ],
    });
    await prisma.conversation.create({
      data: {
        id: lockedConversationId,
        archiveId,
        kind: "direct",
        stableKey: "locked-conversation",
        uiVisibility: "locked",
      },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("survives runtime recreation, stores only a hash, and enforces archive scope", async () => {
    const firstRuntime = new PrismaSessionStore(prisma);
    const token = await firstRuntime.create(principal);
    const secondRuntime = new PrismaSessionStore(prisma);

    await expect(secondRuntime.get(token)).resolves.toEqual(principal);
    const stored = await prisma.authSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { tokenHash: true },
    });
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(stored?.tokenHash).not.toBe(token);

    const auth = new OidcAuth(provider, { findBySubject: async () => null }, secondRuntime);
    await expect(auth.validate(token, archiveId)).resolves.toEqual(principal);
    await expect(auth.validate(token, otherArchiveId)).resolves.toBeNull();
  });

  it("globally revokes sessions while leaving concurrent sessions isolated", async () => {
    const firstRuntime = new PrismaSessionStore(prisma);
    const secondRuntime = new PrismaSessionStore(prisma);
    const revoked = await firstRuntime.create(principal);
    const stillValid = await firstRuntime.create(principal);

    await secondRuntime.revoke(revoked);
    await expect(firstRuntime.get(revoked)).resolves.toBeNull();
    await expect(secondRuntime.get(stillValid)).resolves.toEqual(principal);
  });

  it("rejects and bounded-cleans expired sessions", async () => {
    const expiredRuntime = new PrismaSessionStore(prisma, -1);
    const token = await expiredRuntime.create(principal);
    await expect(expiredRuntime.get(token)).resolves.toBeNull();
    await expect(expiredRuntime.cleanupExpired(1)).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      prisma.authSession.findUnique({ where: { tokenHash: hashToken(token) } }),
    ).resolves.toBeNull();
  });

  it("isolates, consumes, expires, revokes, and restarts step-up grants", async () => {
    const sessionStore = new PrismaSessionStore(prisma);
    const session = await sessionStore.create(principal);
    const unlocks = new PrismaUnlockStore(prisma);
    await expect(
      unlocks.createChallenge({
        state: "synthetic-step-up-state",
        sessionToken: session,
        archiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(true);
    await expect(
      unlocks.createChallenge({
        state: "cross-archive-state",
        sessionToken: session,
        archiveId: otherArchiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(false);
    await expect(
      unlocks.findChallenge({ state: "synthetic-step-up-state", sessionToken: session }),
    ).resolves.toEqual({ archiveId, conversationId: lockedConversationId, archiveWide: false });
    await expect(
      unlocks.consumeChallenge({ state: "synthetic-step-up-state", sessionToken: session }),
    ).resolves.toBe(true);
    await expect(
      unlocks.consumeChallenge({ state: "synthetic-step-up-state", sessionToken: session }),
    ).resolves.toBe(false);

    const grant = await unlocks.createGrant({
      sessionToken: session,
      archiveId,
      conversationId: lockedConversationId,
    });
    await expect(
      unlocks.validateGrant({
        grantToken: grant,
        sessionToken: session,
        archiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(true);
    await expect(
      unlocks.validateGrant({
        grantToken: grant,
        sessionToken: session,
        archiveId: otherArchiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(false);
    await expect(
      prisma.unlockGrant.findUnique({ where: { tokenHash: hashToken(grant) } }),
    ).resolves.toMatchObject({
      tokenHash: hashToken(grant),
    });

    const restarted = new PrismaUnlockStore(prisma);
    await expect(
      restarted.validateGrant({
        grantToken: grant,
        sessionToken: session,
        archiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(false);

    const readRuntime = (unlocks: PrismaUnlockStore) => ({
      auth: {
        principalForRequest: async () => principal,
        grantedConversationIds: async () =>
          unlocks.listGrantedConversationIds({ sessionToken: session, archiveId }),
      },
      conversationPrivacy: {
        list: async () => [
          {
            archiveId,
            conversationId: lockedConversationId,
            uiVisibility: "locked" as const,
            mcpAccess: "allowed" as const,
          },
        ],
        updatePolicy: async () => {
          throw new Error("not used");
        },
      },
      reads: {
        listConversations: async (input: {
          uiAccess?: { authorizedConversationIds?: string[] };
        }) => ({
          items: input.uiAccess?.authorizedConversationIds?.includes(lockedConversationId)
            ? [
                {
                  id: lockedConversationId,
                  title: "Locked conversation",
                  participantCount: 0,
                  lastMessageAt: null,
                },
              ]
            : [],
          hasMore: false,
        }),
      },
    });
    const privacyRoute = (unlocks: PrismaUnlockStore) =>
      createPrivacyRoute({ getRuntime: () => readRuntime(unlocks) });
    const conversationsRoute = (unlocks: PrismaUnlockStore) =>
      createConversationsRoute({ getRuntime: () => readRuntime(unlocks) });

    const unlockedPrivacy = await (
      await privacyRoute(unlocks)(new Request("http://localhost/api/privacy"))
    ).json();
    expect(unlockedPrivacy).toMatchObject({ lockedFolder: { unlocked: true } });
    expect(unlockedPrivacy.policies).toEqual(
      expect.arrayContaining([expect.objectContaining({ conversationId: lockedConversationId })]),
    );
    await expect(
      (
        await conversationsRoute(unlocks)(
          new Request("http://localhost/api/conversations?mode=locked"),
        )
      ).json(),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ id: lockedConversationId })] });
    await expect(
      (await privacyRoute(restarted)(new Request("http://localhost/api/privacy"))).json(),
    ).resolves.toEqual({
      policies: [],
      lockedFolder: { available: true, unlocked: false },
    });
    await expect(
      (
        await conversationsRoute(restarted)(
          new Request("http://localhost/api/conversations?mode=locked"),
        )
      ).json(),
    ).resolves.toEqual({ items: [], hasMore: false });

    const expired = new PrismaUnlockStore(prisma, 300, -1);
    const expiredGrant = await expired.createGrant({
      sessionToken: session,
      archiveId,
      conversationId: lockedConversationId,
    });
    await expect(
      expired.validateGrant({
        grantToken: expiredGrant,
        sessionToken: session,
        archiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(false);
    await unlocks.revokeSession(session);
    await expect(
      unlocks.validateGrant({
        grantToken: grant,
        sessionToken: session,
        archiveId,
        conversationId: lockedConversationId,
      }),
    ).resolves.toBe(false);
    await sessionStore.revoke(session);
  });
});
