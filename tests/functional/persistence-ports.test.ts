import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaPersistence } from "../../src/infrastructure/db/prisma-persistence.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const ports = createPrismaPersistence(prisma);
const userId = randomUUID();
const archiveIds = [randomUUID(), randomUUID()];

describe("archive-scoped persistence ports", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await ports.users.create(userId, { id: userId });
    await ports.archives.create(archiveIds[0], { id: archiveIds[0], userId, name: "one" });
    await ports.archives.create(archiveIds[1], { id: archiveIds[1], userId, name: "two" });
    await ports.sources.create(archiveIds[0], {
      id: randomUUID(),
      kind: "whatsapp",
      stableKey: "backup",
      sha256: "a".repeat(64),
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("returns only records belonging to the explicit archive", async () => {
    expect(await ports.sources.list(archiveIds[0])).toHaveLength(1);
    expect(await ports.sources.list(archiveIds[1])).toHaveLength(0);
    const source = (await ports.sources.list(archiveIds[0]))[0];
    expect(source).toBeDefined();
    expect(await ports.sources.findById(archiveIds[1], String(source?.id))).toBeNull();
  });

  it("exposes every modeled aggregate through an archive-scoped port", () => {
    for (const port of Object.values(ports)) expect(port.list).toBeTypeOf("function");
  });
});
