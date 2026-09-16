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

let activeProductionRuntime: WebRuntime | undefined;
export function productionWebRuntime(): WebRuntime {
  activeProductionRuntime ??= createProductionWebRuntime();
  return activeProductionRuntime;
}
function createProductionWebRuntime(): WebRuntime {
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
  };
}
