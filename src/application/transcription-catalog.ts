export interface TranscriptionModel {
  readonly id: string;
  readonly label: string;
}

export interface TranscriptionCatalogPort {
  discover(): Promise<readonly TranscriptionModel[]>;
}

export type CatalogResult =
  | { readonly kind: "ready"; readonly models: readonly TranscriptionModel[] }
  | { readonly kind: "error" };

const MAX_MODELS = 50;

/** Keep provider-specific capabilities and credentials behind the catalog port. */
export function allowlistedTranscriptionModels(
  models: readonly TranscriptionModel[],
  allowedIds: ReadonlySet<string>,
): readonly TranscriptionModel[] {
  return models
    .filter(
      (model) => allowedIds.has(model.id) && model.id.length <= 256 && model.label.length <= 256,
    )
    .slice(0, MAX_MODELS);
}

export class CachedTranscriptionCatalog implements TranscriptionCatalogPort {
  private cached:
    | { readonly expiresAt: number; readonly models: readonly TranscriptionModel[] }
    | undefined;

  public constructor(
    private readonly source: TranscriptionCatalogPort,
    private readonly ttlMs = 60_000,
  ) {}

  public async discover(): Promise<readonly TranscriptionModel[]> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.models;
    const models = (await this.source.discover()).slice(0, MAX_MODELS);
    this.cached = { models, expiresAt: now + this.ttlMs };
    return models;
  }
}

export interface TranscriptionSettingsService {
  read(archiveId: string): Promise<TranscriptionSettingsRead>;
  select(archiveId: string, modelId: string | null): Promise<TranscriptionSettingsRead>;
}

export interface TranscriptionSettingsRead {
  readonly models: readonly TranscriptionModel[];
  readonly selectedModel: string | null;
  readonly selectedModelState: "selected" | "unset" | "unavailable";
  readonly discovery: "ready" | "error";
}

export class OwnerTranscriptionSettings implements TranscriptionSettingsService {
  public constructor(
    private readonly settings: {
      get(archiveId: string): Promise<string | null>;
      set(archiveId: string, modelId: string | null): Promise<string | null>;
    },
    private readonly catalog: TranscriptionCatalogPort,
  ) {}

  public async read(archiveId: string): Promise<TranscriptionSettingsRead> {
    const selectedModel = await this.settings.get(archiveId);
    try {
      const models = await this.catalog.discover();
      return state(models, selectedModel, "ready");
    } catch {
      return state([], selectedModel, "error");
    }
  }

  public async select(
    archiveId: string,
    modelId: string | null,
  ): Promise<TranscriptionSettingsRead> {
    const current = await this.read(archiveId);
    if (current.discovery === "error") throw new Error("transcription catalog unavailable");
    if (modelId !== null && !current.models.some((model) => model.id === modelId))
      throw new Error("transcription model unavailable");
    await this.settings.set(archiveId, modelId);
    return this.read(archiveId);
  }
}

function state(
  models: readonly TranscriptionModel[],
  selectedModel: string | null,
  discovery: "ready" | "error",
): TranscriptionSettingsRead {
  return {
    models,
    selectedModel,
    selectedModelState:
      selectedModel === null
        ? "unset"
        : models.some((model) => model.id === selectedModel)
          ? "selected"
          : "unavailable",
    discovery,
  };
}
