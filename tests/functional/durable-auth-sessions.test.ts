import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OidcAuth, type OidcProvider } from "../../src/application/auth.js";
import { hashToken, PrismaSessionStore } from "../../src/infrastructure/auth/sessions.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const otherArchiveId = randomUUID();
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
});
