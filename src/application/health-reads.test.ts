import { describe, expect, it } from "vitest";
import { ArchiveHealthService, type HealthPersistenceEvidence } from "./health-reads";

const now = new Date("2026-09-10T12:00:00.000Z");
const base: HealthPersistenceEvidence = {
  latestDiscoveredSnapshot: {
    id: "snapshot-a",
    lifecycle: "completed",
    capturedAt: new Date("2026-09-10T10:00:00.000Z"),
    completedAt: new Date("2026-09-10T11:00:00.000Z"),
  },
  latestCompletedSnapshot: {
    id: "snapshot-a",
    lifecycle: "completed",
    capturedAt: new Date("2026-09-10T10:00:00.000Z"),
    completedAt: new Date("2026-09-10T11:00:00.000Z"),
  },
  latestMessageAt: new Date("2026-09-10T11:30:00.000Z"),
  jobs: [
    {
      id: "job-a",
      status: "completed",
      createdAt: new Date("2026-09-10T10:00:00.000Z"),
      startedAt: new Date("2026-09-10T10:01:00.000Z"),
      finishedAt: new Date("2026-09-10T11:00:00.000Z"),
    },
  ],
  counts: { messages: 4, conversations: 2, people: 3 },
  media: { referenced: 2, available: 1, missing: 1, unsafe: 0, unresolved: 0 },
  unsupportedTypes: [],
};

describe("archive health read service", () => {
  it("returns reconciled evidence for an active archive", async () => {
    const service = new ArchiveHealthService(
      { getHealthEvidence: async () => base },
      { now: () => now },
    );
    await expect(service.getArchiveHealth({ archiveId: "archive-a" })).resolves.toMatchObject({
      archiveId: "archive-a",
      state: "warning",
      freshness: "fresh",
      latestMessageAt: "2026-09-10T11:30:00.000Z",
      counts: { messages: 4, conversations: 2, people: 3, mediaReferenced: 2, mediaAvailable: 1 },
      media: { referenced: 2, available: 1, missing: 1 },
      lastJob: { id: "job-a", status: "completed", durationMilliseconds: 3540000 },
    });
  });

  it.each([
    [
      "empty",
      {
        ...base,
        latestCompletedSnapshot: undefined,
        counts: { messages: 0, conversations: 0, people: 0 },
      },
    ],
    [
      "failed",
      {
        ...base,
        jobs: [{ ...base.jobs[0]!, status: "failed", errorClass: "invalid-key /secret" }],
      },
    ],
    [
      "in-progress",
      { ...base, jobs: [{ ...base.jobs[0]!, status: "decrypting", finishedAt: undefined }] },
    ],
    [
      "stale",
      {
        ...base,
        latestCompletedSnapshot: {
          ...base.latestCompletedSnapshot!,
          completedAt: new Date("2026-09-08T00:00:00.000Z"),
        },
      },
    ],
    ["unsupported", { ...base, unsupportedTypes: [{ type: "999", count: 2 }] }],
  ] as const)("classifies %s state from persistence evidence", async (state, evidence) => {
    const result = await new ArchiveHealthService(
      { getHealthEvidence: async () => evidence },
      { now: () => now },
    ).getHealth({ archiveId: "archive-a" });
    expect(result.state).toBe(state);
  });

  it("bounds jobs and redacts failure class, paths, and content", async () => {
    const secret = "secret /archive/private message";
    let receivedArchive = "";
    const result = await new ArchiveHealthService(
      {
        getHealthEvidence: async ({ archiveId, jobLimit }) => {
          receivedArchive = archiveId;
          expect(jobLimit).toBe(1);
          return {
            ...base,
            jobs: [
              {
                ...base.jobs[0]!,
                status: "failed",
                errorClass: secret,
              },
              { ...base.jobs[0]!, id: "job-old" },
            ],
          };
        },
      },
      { now: () => now, maxJobs: 1 },
    ).getArchiveHealth({ archiveId: "archive-b" });
    expect(receivedArchive).toBe("archive-b");
    expect(result.jobs).toHaveLength(1);
    expect(result.failures).toEqual([
      {
        code: "IMPORT_FAILURE",
        message: "The import did not complete; retry after reviewing configuration.",
        retryable: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
