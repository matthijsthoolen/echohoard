import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  StableBatchClaimer,
  transitionDelivery,
  transitionImportJob,
  transitionSnapshot,
} from "./echohoard.js";

const date = new Date("2026-01-01T00:00:00Z");
describe("snapshot intake transitions", () => {
  it("permits the delivery happy path", () => {
    const d = {
      id: "d",
      path: "/data/inbox/d",
      files: [],
      discoveredAt: date,
      status: "discovered" as const,
    };
    expect(
      transitionDelivery(
        transitionDelivery(transitionDelivery(d, "settling"), "claimed"),
        "completed",
      ).status,
    ).toBe("completed");
  });
  it("rejects terminal delivery transitions", () => {
    const d = { id: "d", path: "p", files: [], discoveredAt: date, status: "completed" as const };
    expect(() => transitionDelivery(d, "claimed")).toThrow(InvalidTransitionError);
  });
  it("supports retry from failed snapshot and job", () => {
    const s = {
      id: "s",
      deliveryId: "d",
      sourceHash: "a",
      path: "p",
      createdAt: date,
      status: "failed" as const,
    };
    const j = { id: "j", snapshotId: "s", status: "failed" as const, updatedAt: date };
    expect(transitionSnapshot(s, "pending").status).toBe("pending");
    expect(transitionImportJob(j, "queued").status).toBe("queued");
  });
  it("does not expose lease after queueing", () => {
    const j = { id: "j", snapshotId: "s", status: "leased" as const, lease: "l", updatedAt: date };
    expect(transitionImportJob(j, "queued").lease).toBeUndefined();
  });
});

describe("stable inbox batch claiming", () => {
  const file = (size: number) => [{ name: "manifest.json", size, modifiedAt: date }];
  const clock = { now: () => date, sleep: async () => {} };

  it("does not claim changing deliveries", async () => {
    let reads = 0;
    const inbox = {
      listDeliveries: async () => ["d"],
      inspect: async () => file(++reads),
      claim: async () => "/claimed/d",
    };
    await expect(
      new StableBatchClaimer(inbox, clock, { quietPeriodMilliseconds: 1 }).settleAndClaim(
        "/inbox",
        "d",
      ),
    ).resolves.toBeNull();
  });

  it("claims only once after identical metadata", async () => {
    let claims = 0;
    const inbox = {
      listDeliveries: async () => ["d"],
      inspect: async () => file(1),
      claim: async () => (claims++ === 0 ? "/claimed/d" : null),
    };
    const claimer = new StableBatchClaimer(inbox, clock, { quietPeriodMilliseconds: 1 });
    await expect(claimer.settleAndClaim("/inbox", "d")).resolves.toBe("/claimed/d");
    await expect(claimer.settleAndClaim("/inbox", "d")).resolves.toBeNull();
  });
});
