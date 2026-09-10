import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const ids = Array.from({ length: 5 }, () => randomUUID());

describe("archive ownership constraints", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" (id, "updatedAt") VALUES ('${ids[0]}', now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Archive" (id, "userId", name, "updatedAt") VALUES ('${ids[1]}','${ids[0]}','one',now()),('${ids[2]}','${ids[0]}','two',now())`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Source" (id,"archiveId",kind,"stableKey",sha256,"updatedAt") VALUES ('${ids[3]}','${ids[1]}','whatsapp','backup','${"a".repeat(64)}',now())`,
    );
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id='${ids[0]}'`);
    await prisma.$disconnect();
  });

  it("scopes source identity to an archive", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Source" ("archiveId",kind,"stableKey",sha256,"updatedAt") VALUES ('${ids[1]}','whatsapp','backup','${"b".repeat(64)}',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Source" ("archiveId",kind,"stableKey",sha256,"updatedAt") VALUES ('${ids[2]}','whatsapp','backup','${"b".repeat(64)}',now())`,
      ),
    ).resolves.toBe(1);
  });
  it("rejects snapshot and job source references across archives", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Snapshot" ("archiveId","sourceId",sha256,"createdAt") VALUES ('${ids[2]}','${ids[3]}','${"c".repeat(64)}',now())`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ImportJob" ("archiveId","sourceId","updatedAt") VALUES ('${ids[2]}','${ids[3]}',now())`,
      ),
    ).rejects.toThrow();
  });
});
