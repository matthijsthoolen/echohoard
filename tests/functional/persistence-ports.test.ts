import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaPersistence } from "../../src/infrastructure/db/prisma-persistence.js";
import { createFixtureOwnedAccount } from "./owned-account-fixture.js";

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
    const accountId = await createFixtureOwnedAccount(prisma, archiveIds[0]);
    await ports.sources.create(archiveIds[0], {
      id: randomUUID(),
      ownedAccountId: accountId,
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
    const aggregatePorts = Object.entries(ports).filter(
      ([name]) => name !== "liveEventInbox" && name !== "transcriptionSettings",
    );
    for (const [, port] of aggregatePorts) expect(port.list).toBeTypeOf("function");
  });

  it("exposes owned accounts through an archive-scoped port", async () => {
    expect(await ports.ownedAccounts.list(archiveIds[0])).toHaveLength(1);
    expect(await ports.ownedAccounts.list(archiveIds[1])).toHaveLength(0);
  });

  it("updates live settings only inside the owning archive", async () => {
    const accounts = await ports.ownedAccounts.list(archiveIds[0]);
    const accountId = String(accounts[0]?.id);
    const updated = await ports.ownedAccounts.update(archiveIds[0], accountId, {
      liveEnabled: true,
      pausedAt: null,
    });
    expect(updated).toMatchObject({ liveEnabled: true, pausedAt: null });
    expect(await ports.ownedAccounts.findById(archiveIds[1], accountId)).toBeNull();
    await ports.ownedAccounts.update(archiveIds[0], accountId, { liveEnabled: false });
  });
});
