import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPrincipalDirectory } from "../../src/infrastructure/auth/oidc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL functional suite");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const userId = randomUUID();
const archiveId = randomUUID();
const issuer = "https://issuer.example.test";

describe("PostgreSQL OIDC identity admission", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId } });
    await prisma.archive.create({ data: { id: archiveId, userId, name: "OIDC fixture" } });
  });

  afterAll(async () => {
    await prisma.archiveIdentity.deleteMany({
      where: { issuer, subject: { in: ["bootstrap-owner", "bootstrap-member"] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("atomically admits one concurrent first identity and queues the other", async () => {
    const directoryA = new PrismaPrincipalDirectory(prisma, issuer, archiveId);
    const directoryB = new PrismaPrincipalDirectory(prisma, issuer, archiveId);
    const results = await Promise.all([
      directoryA.findBySubject(issuer, "first-a"),
      directoryB.findBySubject(issuer, "first-b"),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result?.role === "admin")).toHaveLength(1);
    await expect(
      prisma.archiveIdentity.findMany({
        where: { archiveId },
        orderBy: { subject: "asc" },
        select: { subject: true, role: true },
      }),
    ).resolves.toEqual([
      { subject: "first-a", role: expect.any(String) },
      { subject: "first-b", role: expect.any(String) },
    ]);
  });

  it("requires the existing administrator to approve a pending identity", async () => {
    const directory = new PrismaPrincipalDirectory(prisma, issuer, archiveId);
    const identities = await prisma.archiveIdentity.findMany({
      where: { archiveId },
      select: { subject: true, role: true },
    });
    const adminSubject = identities.find((identity) => identity.role === "admin")?.subject;
    const pendingSubject = identities.find((identity) => identity.role === "pending")?.subject;
    const admin = adminSubject ? await directory.findBySubject(issuer, adminSubject) : null;
    expect(admin?.role).toBe("admin");
    expect(pendingSubject).toBeDefined();
    expect(
      await directory.approveIdentity({
        archiveId,
        approverIssuer: issuer,
        approverSubject: adminSubject ?? "",
        issuer,
        subject: pendingSubject ?? "",
      }),
    ).toBe(true);
    await expect(directory.findBySubject(issuer, pendingSubject!)).resolves.toMatchObject({
      archiveId,
      subject: pendingSubject,
      role: "member",
    });
    await expect(
      directory.findBySubject("https://other.example.test", "intruder"),
    ).resolves.toBeNull();
  });

  it("bootstraps the first archive when no archive is configured", async () => {
    const directory = new PrismaPrincipalDirectory(prisma, issuer);
    const result = await directory.findBySubject(issuer, "bootstrap-owner");

    expect(result).toMatchObject({ issuer, subject: "bootstrap-owner", role: "admin" });
    await expect(
      prisma.archiveIdentity.findFirst({
        where: { issuer, subject: "bootstrap-owner" },
        select: { role: true, archive: { select: { name: true } } },
      }),
    ).resolves.toMatchObject({ role: "admin", archive: { name: expect.any(String) } });
  });

  it("queues a later identity in the bootstrapped archive", async () => {
    const directory = new PrismaPrincipalDirectory(prisma, issuer);
    const result = await directory.findBySubject(issuer, "bootstrap-member");

    expect(result).toBeNull();
    await expect(
      prisma.archiveIdentity.findFirst({
        where: { issuer, subject: "bootstrap-member" },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: "pending" });
  });
});
