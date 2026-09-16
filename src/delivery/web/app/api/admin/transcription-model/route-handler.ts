import type { WebRuntime } from "../../../../runtime";
import type { TranscriptionSettingsRead } from "../../../../../../application/transcription-catalog";

export interface TranscriptionModelRouteDependencies {
  readonly getRuntime: () =>
    | {
        readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
        readonly transcription?: {
          read(archiveId: string): Promise<TranscriptionSettingsRead>;
          select(archiveId: string, modelId: string | null): Promise<TranscriptionSettingsRead>;
        };
      }
    | undefined;
}

export function createTranscriptionModelGetRoute({
  getRuntime,
}: TranscriptionModelRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.transcription) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    try {
      return json(await runtime.transcription.read(principal.archiveId));
    } catch {
      return unavailable();
    }
  };
}

export function createTranscriptionModelPutRoute({
  getRuntime,
}: TranscriptionModelRouteDependencies) {
  return async function PUT(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.transcription) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    const modelId = await parseModel(request);
    if (modelId === undefined)
      return Response.json({ error: "Invalid transcription model" }, { status: 400 });
    try {
      return json(await runtime.transcription.select(principal.archiveId, modelId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "transcription model unavailable")
        return Response.json(
          { error: "Selected transcription model is unavailable" },
          { status: 409 },
        );
      return unavailable();
    }
  };
}

async function parseModel(request: Request): Promise<string | null | undefined> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || !("modelId" in body))
      return undefined;
    const value = body.modelId;
    if (value === null) return null;
    return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
  } catch {
    return undefined;
  }
}

function json(value: TranscriptionSettingsRead): Response {
  return Response.json(value, { headers: { "Cache-Control": "private, no-store" } });
}

function forbidden(): Response {
  return Response.json({ error: "Administrator approval required" }, { status: 403 });
}

function unavailable(): Response {
  return Response.json({ error: "Transcription settings unavailable" }, { status: 503 });
}
