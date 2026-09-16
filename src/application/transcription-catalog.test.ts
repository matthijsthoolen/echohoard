import { describe, expect, it, vi } from "vitest";
import {
  CachedTranscriptionCatalog,
  OwnerTranscriptionSettings,
  allowlistedTranscriptionModels,
} from "./transcription-catalog";

const models = [
  { id: "audio/allowed", label: "Allowed" },
  { id: "text/not-allowed", label: "Not allowed" },
];

describe("transcription model settings", () => {
  it("bounds the catalog to the explicit allowlist", () => {
    expect(allowlistedTranscriptionModels(models, new Set(["audio/allowed"]))).toEqual([models[0]]);
  });

  it("caches bounded discovery", async () => {
    const discover = vi.fn(async () => models);
    const catalog = new CachedTranscriptionCatalog({ discover }, 60_000);
    await catalog.discover();
    await catalog.discover();
    expect(discover).toHaveBeenCalledOnce();
  });

  it("does not accept unavailable selections and preserves unavailable saved values", async () => {
    const set = vi.fn(async (_archiveId: string, model: string | null) => model);
    const service = new OwnerTranscriptionSettings(
      { get: async () => "audio/removed", set },
      { discover: async () => [models[0]] },
    );
    await expect(service.select("archive-1", "text/not-allowed")).rejects.toThrow("unavailable");
    expect(set).not.toHaveBeenCalled();
    await expect(service.read("archive-1")).resolves.toMatchObject({
      selectedModel: "audio/removed",
      selectedModelState: "unavailable",
    });
  });

  it("reports catalog errors without exposing provider details", async () => {
    const service = new OwnerTranscriptionSettings(
      { get: async () => null, set: async () => null },
      {
        discover: async () => {
          throw new Error("provider secret");
        },
      },
    );
    await expect(service.read("archive-1")).resolves.toEqual({
      models: [],
      selectedModel: null,
      selectedModelState: "unset",
      discovery: "error",
    });
  });
});
