import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { ArchivePrincipal, SessionStore } from "../../application/auth.js";

const DEFAULT_TTL_SECONDS = 3_600;
const MAX_CLEANUP_ROWS = 100;

/** PostgreSQL-backed opaque sessions. Only a SHA-256 token digest is stored;
 * the browser token never crosses this persistence boundary. */
export class PrismaSessionStore implements SessionStore {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlSeconds = DEFAULT_TTL_SECONDS,
  ) {}

  public async create(principal: ArchivePrincipal): Promise<string> {
    const token = randomUUID();
    await this.prisma.authSession.create({
      data: {
        tokenHash: hashToken(token),
        userId: principal.userId,
        archiveId: principal.archiveId,
        issuer: principal.issuer,
        subject: principal.subject,
        ...(principal.role ? { role: principal.role } : {}),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1_000),
      },
    });
    return token;
  }

  public async get(token: string | undefined): Promise<ArchivePrincipal | null> {
    if (!token) return null;
    const row = await this.prisma.authSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        userId: true,
        archiveId: true,
        issuer: true,
        subject: true,
        role: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
    return {
      userId: row.userId,
      archiveId: row.archiveId,
      issuer: row.issuer,
      subject: row.subject,
      ...(row.role === "admin" || row.role === "member" ? { role: row.role } : {}),
    };
  }

  public async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.authSession.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  public async cleanupExpired(limit: number): Promise<number> {
    const bounded = Math.max(1, Math.min(MAX_CLEANUP_ROWS, Math.trunc(limit)));
    return this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "AuthSession"
      WHERE id IN (
        SELECT id FROM "AuthSession"
        WHERE "expiresAt" <= CURRENT_TIMESTAMP OR "revokedAt" IS NOT NULL
        ORDER BY "expiresAt" ASC, id ASC
        LIMIT ${bounded}
      )
    `);
  }
}

export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");
