import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { OidcAuth } from "../../application/auth";
import { ArchiveHealthService } from "../../application/health-reads";
import { ArchiveReadService, CursorCodec } from "../../application/reads";
import { ArchiveStatisticsService } from "../../application/statistics";
import { parseEnv } from "../../config/env";
import {
  PrismaHealthReadPersistence,
  PrismaReadPersistence,
  PrismaStatisticsPersistence,
  createPrismaPersistence,
} from "../../infrastructure/db/prisma-persistence";
import { PrismaMediaDelivery } from "../../infrastructure/db/media-delivery";
import { HttpOidcProvider, PrismaPrincipalDirectory } from "../../infrastructure/auth/oidc";
import { PrismaSessionStore } from "../../infrastructure/auth/sessions";
import { PrismaUnlockStore } from "../../infrastructure/auth/unlocks";
import { WebAuthBoundary } from "./auth";
import type { WebRuntime } from "./runtime";
import { productionAuthDiagnostic } from "../../application/auth-diagnostics";
import {
  OwnerTranscriptionSettings,
  CachedTranscriptionCatalog,
} from "../../application/transcription-catalog";
import { createLiteLlmCatalog } from "../../infrastructure/litellm/catalog";
import { ConversationGroupingService } from "../../application/conversation-grouping";
import { PrismaConversationGroupingPersistence } from "../../infrastructure/db/conversation-grouping";
import {
  AccountSettingsService,
  PairingSessionController,
} from "../../application/account-pairing";
import { PrismaLiveAccountHealthPersistence } from "../../infrastructure/db/prisma-persistence";
import { HttpFixedSidecarOperations } from "../../infrastructure/wacli/sidecar-operations";
import type { EchohoardEnv } from "../../config/env";
import type { AccountSettingsPersistencePort } from "../../application/persistence";
import {
  LiveEventIntakeService,
  CountingLiveEventMetrics,
} from "../../application/live-event-intake";
import {
  PrismaLiveEventAccountResolver,
  PrismaLiveEventInboxPersistence,
} from "../../infrastructure/db/prisma-persistence";
import { parseWacliWebhookEvent } from "../../adapters/wacli/contract";
import { normalizeWacliEvent } from "../../adapters/wacli/normalize";

let activeProductionRuntime: WebRuntime | undefined;
export function productionWebRuntime(): WebRuntime {
  activeProductionRuntime ??= createProductionWebRuntime();
  return activeProductionRuntime;
}

export function createProductionWebRuntime(): WebRuntime {
  const settings = parseEnv();
  if (
    !settings.OIDC_ISSUER ||
    !settings.OIDC_CLIENT_ID ||
    !settings.OIDC_REDIRECT_URI ||
    !settings.OIDC_CLIENT_SECRET_FILE
  )
    throw new Error("OIDC web configuration is incomplete");
  const secret = readFileSync(settings.OIDC_CLIENT_SECRET_FILE, "utf8").trim();
  if (!secret) throw new Error("OIDC client secret file is empty");
  const archiveId = settings.OIDC_ARCHIVE_ID;
  if (!archiveId) throw new Error("OIDC archive configuration is incomplete");
  const prisma = new PrismaClient();
  const unlocks = new PrismaUnlockStore(prisma);
  const persistence = createPrismaPersistence(prisma);
  const catalog = new CachedTranscriptionCatalog(
    createLiteLlmCatalog(
      settings.LITELLM_BASE_URL,
      settings.LITELLM_API_KEY_FILE,
      settings.ECHOHOARD_TRANSCRIPTION_MODELS,
    ),
  );
  const reads = new ArchiveReadService(new PrismaReadPersistence(prisma), new CursorCodec(secret));
  const accountSettings = createProductionAccountSettings(
    prisma,
    persistence.ownedAccounts,
    settings,
  );
  const liveEventIntake = createProductionLiveEventIntake(prisma, archiveId, settings);
  return {
    auth: new WebAuthBoundary(
      new OidcAuth(
        new HttpOidcProvider(
          settings.OIDC_ISSUER,
          settings.OIDC_CLIENT_ID,
          secret,
          settings.OIDC_REDIRECT_URI,
          fetch,
          productionAuthDiagnostic,
        ),
        new PrismaPrincipalDirectory(prisma, settings.OIDC_ISSUER, settings.OIDC_ARCHIVE_ID),
        new PrismaSessionStore(prisma),
        productionAuthDiagnostic,
        unlocks,
      ),
      "/",
      productionAuthDiagnostic,
    ),
    reads: {
      listConversations: (query) => reads.listConversations(query),
      listPeople: (query) => reads.listPeople(query),
      listMessages: (query) => reads.listMessages(query),
      search: (query) => reads.search(query),
      archiveHealth: (query) =>
        new ArchiveHealthService(new PrismaHealthReadPersistence(prisma)).getArchiveHealth(query),
      archiveStatistics: (query) =>
        new ArchiveStatisticsService(new PrismaStatisticsPersistence(prisma)).getStatistics(query),
    },
    media: new PrismaMediaDelivery(prisma, `${process.env.ECHOHOARD_DATA_DIR ?? "/data"}/media`),
    transcription: new OwnerTranscriptionSettings(persistence.transcriptionSettings, catalog),
    grouping: new ConversationGroupingService(new PrismaConversationGroupingPersistence(prisma)),
    accountSettings,
    liveEventIntake,
  };
}

export function createProductionLiveEventIntake(
  prisma: PrismaClient,
  archiveId: string,
  settings: Pick<EchohoardEnv, "ECHOHOARD_WACLI_WEBHOOK_SECRET_FILE">,
): LiveEventIntakeService {
  if (!settings.ECHOHOARD_WACLI_WEBHOOK_SECRET_FILE)
    throw new Error("wacli webhook secret file is not configured");
  const webhookSecret = readFileSync(settings.ECHOHOARD_WACLI_WEBHOOK_SECRET_FILE, "utf8").trim();
  if (!webhookSecret) throw new Error("wacli webhook secret file is empty");
  return new LiveEventIntakeService(
    new PrismaLiveEventAccountResolver(prisma, archiveId, webhookSecret),
    new PrismaLiveEventInboxPersistence(prisma),
    new CountingLiveEventMetrics(),
    {
      validate: (payload, accountKey) => {
        const event = parseWacliWebhookEvent(payload, accountKey);
        return {
          kind: event.kind,
          sourceEventKey: event.sourceEventKey,
          observedAt: event.kind === "chat_presence" ? undefined : event.observedAt,
          payload: JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>,
        };
      },
    },
  );
}

export function createProductionAccountSettings(
  prisma: PrismaClient,
  persistence: AccountSettingsPersistencePort,
  settings: Pick<
    EchohoardEnv,
    "ECHOHOARD_WACLI_CONTROL_URL" | "ECHOHOARD_WACLI_CONTROL_TIMEOUT_MS"
  >,
  fetcher: typeof fetch = fetch,
): AccountSettingsService {
  const sidecar = new HttpFixedSidecarOperations(
    settings.ECHOHOARD_WACLI_CONTROL_URL,
    fetcher,
    settings.ECHOHOARD_WACLI_CONTROL_TIMEOUT_MS,
  );
  return new AccountSettingsService(
    persistence,
    new PrismaLiveAccountHealthPersistence(prisma),
    sidecar,
    new PairingSessionController(persistence, sidecar),
  );
}
