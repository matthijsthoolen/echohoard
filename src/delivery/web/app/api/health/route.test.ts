import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../application/auth";
import type { ArchiveHealthRead } from "../../../../../application/health-reads";
import { createHealthRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};

const health: ArchiveHealthRead = {
  archiveId: "archive-1",
  state: "healthy",
  freshness: "fresh",
  snapshots: {},
  jobs: [],
  counts: {
    messages: 2,
    conversations: 1,
    people: 2,
    mediaReferenced: 0,
    mediaAvailable: 0,
    unsupported: 0,
  },
  media: { referenced: 0, available: 0, missing: 0, unsafe: 0, unresolved: 0 },
  unsupportedTypes: [],
  failures: [],
};

describe("archive health route", () => {
  it("requires an authenticated configured runtime", async () => {
    const route = createHealthRoute({ getRuntime: () => undefined });
    expect((await route(new Request("http://localhost/api/health"))).status).toBe(401);
    const denied = createHealthRoute({
      getRuntime: () => ({ auth: { principalForRequest: () => null }, reads: {} }),
    });
    expect((await denied(new Request("http://localhost/api/health"))).status).toBe(401);
  });

  it("uses the session archive and does not expose content or diagnostics", async () => {
    const archiveHealth = vi.fn(async () => health);
    const route = createHealthRoute({
      getRuntime: () => ({
        auth: { principalForRequest: () => principal },
        reads: { archiveHealth },
      }),
    });
    const response = await route(
      new Request("http://localhost/api/health?archiveId=other-archive"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(health);
    expect(archiveHealth).toHaveBeenCalledWith({ archiveId: "archive-1" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("sanitizes service failures and reports an unwired service separately", async () => {
    const failed = createHealthRoute({
      getRuntime: () => ({
        auth: { principalForRequest: () => principal },
        reads: { archiveHealth: vi.fn(async () => { throw new Error("secret /path message"); }) },
      }),
    });
    expect(await (await failed(new Request("http://localhost/api/health"))).json()).toEqual({
      error: "Archive health unavailable",
    });
    const unwired = createHealthRoute({
      getRuntime: () => ({ auth: { principalForRequest: () => principal }, reads: {} }),
    });
    expect((await unwired(new Request("http://localhost/api/health"))).status).toBe(503);
  });
});
