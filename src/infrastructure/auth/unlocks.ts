import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { UnlockStore } from "../../application/auth.js";
import { hashToken } from "./sessions";

const CHALLENGE_TTL_SECONDS = 300;
const GRANT_TTL_SECONDS = 300;
const MAX_CLEANUP_ROWS = 100;

/** PostgreSQL-backed step-up state. Browser state, challenges, and grants are
 * represented only by SHA-256 digests. A runtime id intentionally invalidates
 * grants and in-flight challenges after a web process restart. */
export class PrismaUnlockStore implements UnlockStore {
  private readonly runtimeId = randomUUID();

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly challengeTtlSeconds = CHALLENGE_TTL_SECONDS,
    private readonly grantTtlSeconds = GRANT_TTL_SECONDS,
  ) {}

  public async createFolderChallenge(
    input: Parameters<NonNullable<UnlockStore["createFolderChallenge"]>>[0],
  ): Promise<boolean> {
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: hashToken(input.sessionToken) },
      select: { id: true, archiveId: true, expiresAt: true, revokedAt: true },
    });
    if (
      !session ||
      session.archiveId !== input.archiveId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    )
      return false;
    const firstLocked = await this.prisma.conversation.findFirst({
      where: { archiveId: input.archiveId, uiVisibility: "locked", materialized: true },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return firstLocked ? this.createChallenge({ ...input, conversationId: firstLocked.id }) : false;
  }

  public async createChallenge(
    input: Parameters<UnlockStore["createChallenge"]>[0],
  ): Promise<boolean> {
    if (!input.state || !input.sessionToken || !input.archiveId || !input.conversationId)
      return false;
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: hashToken(input.sessionToken) },
      select: { id: true, archiveId: true, expiresAt: true, revokedAt: true },
    });
    if (
      !session ||
      session.archiveId !== input.archiveId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    )
      return false;
    const conversation = await this.prisma.conversation.findUnique({
      where: { archiveId_id: { archiveId: input.archiveId, id: input.conversationId } },
      select: { uiVisibility: true },
    });
    if (conversation?.uiVisibility !== "locked") return false;
    try {
      await this.prisma.unlockChallenge.create({
        data: {
          tokenHash: hashToken(input.state),
          runtimeId: this.runtimeId,
          sessionHash: hashToken(input.sessionToken),
          authSessionId: session.id,
          archiveId: input.archiveId,
          conversationId: input.conversationId,
          expiresAt: new Date(Date.now() + this.challengeTtlSeconds * 1_000),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        return false;
      throw error;
    }
  }

  public async findChallenge(input: Parameters<UnlockStore["findChallenge"]>[0]) {
    const row = await this.prisma.unlockChallenge.findFirst({
      where: {
        tokenHash: hashToken(input.state),
        runtimeId: this.runtimeId,
        sessionHash: hashToken(input.sessionToken),
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { archiveId: true, conversationId: true },
    });
    return row;
  }

  public async consumeChallenge(
    input: Parameters<UnlockStore["consumeChallenge"]>[0],
  ): Promise<boolean> {
    const result = await this.prisma.unlockChallenge.updateMany({
      where: {
        tokenHash: hashToken(input.state),
        runtimeId: this.runtimeId,
        sessionHash: hashToken(input.sessionToken),
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  }

  public async createGrant(input: Parameters<UnlockStore["createGrant"]>[0]): Promise<string> {
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: hashToken(input.sessionToken) },
      select: { id: true, archiveId: true, expiresAt: true, revokedAt: true },
    });
    if (
      !session ||
      session.archiveId !== input.archiveId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new Error("Cannot grant an inactive session");
    const conversation = await this.prisma.conversation.findUnique({
      where: { archiveId_id: { archiveId: input.archiveId, id: input.conversationId } },
      select: { uiVisibility: true },
    });
    if (conversation?.uiVisibility !== "locked")
      throw new Error("Cannot grant an unlocked conversation");
    const token = randomUUID();
    await this.prisma.unlockGrant.create({
      data: {
        tokenHash: hashToken(token),
        runtimeId: this.runtimeId,
        sessionHash: hashToken(input.sessionToken),
        authSessionId: session.id,
        archiveId: input.archiveId,
        conversationId: input.conversationId,
        expiresAt: new Date(Date.now() + this.grantTtlSeconds * 1_000),
      },
    });
    return token;
  }

  public async createGrantsForArchive(
    input: Parameters<NonNullable<UnlockStore["createGrantsForArchive"]>>[0],
  ): Promise<string> {
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: hashToken(input.sessionToken) },
      select: { id: true, archiveId: true, expiresAt: true, revokedAt: true },
    });
    if (
      !session ||
      session.archiveId !== input.archiveId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new Error("Cannot grant an inactive session");
    const token = randomUUID();
    const row = await this.prisma.conversation.findFirst({
      where: { archiveId: input.archiveId, uiVisibility: "locked", materialized: true },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (!row) throw new Error("No locked conversations");
    await this.prisma.unlockGrant.create({
      data: {
        tokenHash: hashToken(token),
        runtimeId: this.runtimeId,
        sessionHash: hashToken(input.sessionToken),
        authSessionId: session.id,
        archiveId: input.archiveId,
        conversationId: row.id,
        archiveWide: true,
        expiresAt: new Date(Date.now() + this.grantTtlSeconds * 1_000),
      },
    });
    return token;
  }

  public async listGrantedConversationIds(
    input: Parameters<NonNullable<UnlockStore["listGrantedConversationIds"]>>[0],
  ): Promise<readonly string[]> {
    const grant = await this.prisma.unlockGrant.findFirst({
      where: {
        runtimeId: this.runtimeId,
        sessionHash: hashToken(input.sessionToken),
        archiveId: input.archiveId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        authSession: { revokedAt: null, expiresAt: { gt: new Date() } },
      },
      select: { conversationId: true, archiveWide: true },
    });
    if (!grant) return [];
    if (!grant.archiveWide) return [grant.conversationId];
    const rows = await this.prisma.conversation.findMany({
      where: { archiveId: input.archiveId, uiVisibility: "locked", materialized: true },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  public async validateGrant(input: Parameters<UnlockStore["validateGrant"]>[0]): Promise<boolean> {
    const row = await this.prisma.unlockGrant.findFirst({
      where: {
        tokenHash: hashToken(input.grantToken),
        runtimeId: this.runtimeId,
        sessionHash: hashToken(input.sessionToken),
        archiveId: input.archiveId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        authSession: { revokedAt: null, expiresAt: { gt: new Date() } },
        OR: [
          { archiveWide: true },
          {
            archiveWide: false,
            conversationId: input.conversationId,
            conversation: { uiVisibility: "locked" },
          },
        ],
      },
      select: { id: true },
    });
    return row !== null;
  }

  public async revokeSession(sessionToken: string): Promise<void> {
    const sessionHash = hashToken(sessionToken);
    await this.prisma.$transaction([
      this.prisma.unlockGrant.updateMany({
        where: { sessionHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.unlockChallenge.updateMany({
        where: { sessionHash, revokedAt: null, consumedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  public async cleanupExpired(limit: number): Promise<number> {
    const bounded = Math.max(1, Math.min(MAX_CLEANUP_ROWS, Math.trunc(limit)));
    const challenges = await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "UnlockChallenge"
      WHERE id IN (
        SELECT id FROM "UnlockChallenge"
        WHERE "expiresAt" <= CURRENT_TIMESTAMP OR "revokedAt" IS NOT NULL OR "consumedAt" IS NOT NULL
        ORDER BY "expiresAt" ASC, id ASC
        LIMIT ${bounded}
      )
    `);
    const grants = await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "UnlockGrant"
      WHERE id IN (
        SELECT id FROM "UnlockGrant"
        WHERE "expiresAt" <= CURRENT_TIMESTAMP OR "revokedAt" IS NOT NULL
        ORDER BY "expiresAt" ASC, id ASC
        LIMIT ${bounded}
      )
    `);
    return challenges + grants;
  }
}
