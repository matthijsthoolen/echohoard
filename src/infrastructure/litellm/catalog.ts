import { readFileSync } from "node:fs";
import {
  allowlistedTranscriptionModels,
  type TranscriptionCatalogPort,
  type TranscriptionModel,
} from "../../application/transcription-catalog";

type UnknownRecord = Record<string, unknown>;

export class HttpLiteLlmCatalog implements TranscriptionCatalogPort {
  public constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly allowedIds: ReadonlySet<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async discover(): Promise<readonly TranscriptionModel[]> {
    const response = await this.fetcher(this.endpoint, {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("catalog unavailable");
    const body: unknown = await response.json();
    const entries = extractEntries(body);
    const models = entries.flatMap((entry) => {
      const id = stringValue(entry.id ?? entry.model_name ?? entry.model_name_alias);
      if (!id || !this.allowedIds.has(id) || !isTranscriptionCapable(entry)) return [];
      return [{ id, label: id }];
    });
    return allowlistedTranscriptionModels(models, this.allowedIds);
  }
}

export function createLiteLlmCatalog(
  baseUrl: string | undefined,
  secretFile: string | undefined,
  allowedIds: string,
): TranscriptionCatalogPort {
  const ids = new Set(
    allowedIds
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!baseUrl || !secretFile || ids.size === 0) return { discover: async () => [] };
  const secret = readFileSync(secretFile, "utf8").trim();
  if (!secret)
    return {
      discover: async () => {
        throw new Error("catalog credential unavailable");
      },
    };
  return new HttpLiteLlmCatalog(`${baseUrl.replace(/\/$/u, "")}/model/info`, secret, ids);
}

function extractEntries(body: unknown): UnknownRecord[] {
  if (!isRecord(body)) return [];
  const values = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : [];
  return values.filter(isRecord);
}

function isTranscriptionCapable(entry: UnknownRecord): boolean {
  const info = isRecord(entry.model_info) ? entry.model_info : entry;
  const modes = info.input_modalities ?? info.inputModalities ?? info.modalities;
  return (
    (Array.isArray(modes) && modes.some((mode) => mode === "audio" || mode === "video")) ||
    info.supports_audio === true ||
    info.supportsAudio === true
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
