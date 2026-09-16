import { describe, expect, it } from "vitest";
import {
  createTranscriptionModelGetRoute,
  createTranscriptionModelPutRoute,
} from "./route-handler";

const settings = {
  models: [{ id: "audio/allowed", label: "Allowed" }],
  selectedModel: null,
  selectedModelState: "unset" as const,
  discovery: "ready" as const,
};
const principal = { archiveId: "archive-1", role: "admin" as const };

describe("transcription model admin routes", () => {
  it("requires an admin and never trusts an archive query", async () => {
    const read = async (archiveId: string) => ({ ...settings, archiveId });
    const get = createTranscriptionModelGetRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        transcription: { read, select: async () => settings },
      }),
    });
    const response = await get(
      new Request("http://x/api/admin/transcription-model?archiveId=other"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selectedModel: null });
  });

  it("rejects unavailable models and accepts explicit unset", async () => {
    const put = createTranscriptionModelPutRoute({
      getRuntime: () => ({
        auth: { principalForRequest: async () => principal },
        transcription: {
          read: async () => settings,
          select: async (_archiveId: string, modelId: string | null) => {
            if (modelId) throw new Error("transcription model unavailable");
            return settings;
          },
        },
      }),
    });
    expect(
      (
        await put(
          new Request("http://x", { method: "PUT", body: JSON.stringify({ modelId: "bad" }) }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await put(
          new Request("http://x", { method: "PUT", body: JSON.stringify({ modelId: null }) }),
        )
      ).status,
    ).toBe(200);
  });
});
