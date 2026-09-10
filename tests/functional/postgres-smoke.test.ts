import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
}

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

describe("PostgreSQL migration smoke", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("connects to the migrated database and cleans up its client", async () => {
    await expect(prisma.$queryRaw<[{ result: number }]>`SELECT 1 AS result`).resolves.toEqual([
      { result: 1 },
    ]);
    await expect(prisma.$queryRaw<[{ table_name: string }]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    `).resolves.toEqual([{ table_name: "_prisma_migrations" }]);
  });
});
