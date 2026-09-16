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
import { createPrivateMcpServer, McpCredentialAuthenticator } from "../../delivery/mcp/index";

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
  const health = new ArchiveHealthService(new PrismaHealthReadPersistence(prisma));
  const mcp = createProductionMcpServer(settings, reads, health);
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
      archiveHealth: (query) => health.getArchiveHealth(query),
      archiveStatistics: (query) =>
        new ArchiveStatisticsService(new PrismaStatisticsPersistence(prisma)).getStatistics(query),
    },
    mcp,
    media: new PrismaMediaDelivery(prisma, `${process.env.ECHOHOARD_DATA_DIR ?? "/data"}/media`),
    transcription: new OwnerTranscriptionSettings(persistence.transcriptionSettings, catalog),
    grouping: new ConversationGroupingService(new PrismaConversationGroupingPersistence(prisma)),
    accountSettings,
    liveEventIntake,
  };
}

function createProductionMcpServer(
  settings: EchohoardEnv,
  reads: ArchiveReadService,
  health: ArchiveHealthService,
) {
  if (
    !settings.ECHOHOARD_MCP_CREDENTIAL_FILE ||
    !settings.ECHOHOARD_MCP_USER_ID ||
    !settings.ECHOHOARD_MCP_SUBJECT ||
    !settings.ECHOHOARD_MCP_ISSUER ||
    !settings.OIDC_ARCHIVE_ID
  )
    throw new Error("MCP configuration is incomplete");

  return createPrivateMcpServer({
    authenticator: new McpCredentialAuthenticator(settings.ECHOHOARD_MCP_CREDENTIAL_FILE, {
      userId: settings.ECHOHOARD_MCP_USER_ID,
      archiveId: settings.OIDC_ARCHIVE_ID,
      subject: settings.ECHOHOARD_MCP_SUBJECT,
      issuer: settings.ECHOHOARD_MCP_ISSUER,
    }),
    reads,
    health,
    audit: (record) => {
      productionAuthDiagnostic("mcp.tool", {
        tool: record.tool,
        user_id: record.principal.userId,
        archive_id: record.principal.archiveId,
        duration_ms: record.durationMs,
        item_count: record.itemCount,
        payload_bytes: record.payloadBytes,
        status: record.status,
      });
    },
  });
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
