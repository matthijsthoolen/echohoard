import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { OidcAuth, SessionStore } from "../../application/auth";
import { ArchiveHealthService } from "../../application/health-reads";
import { ArchiveReadService, CursorCodec } from "../../application/reads";
import { ArchiveStatisticsService } from "../../application/statistics";
import { parseEnv } from "../../config/env";
import {
  PrismaHealthReadPersistence,
  PrismaReadPersistence,
  PrismaStatisticsPersistence,
} from "../../infrastructure/db/prisma-persistence";
import { PrismaMediaDelivery } from "../../infrastructure/db/media-delivery";
import { HttpOidcProvider, PrismaPrincipalDirectory } from "../../infrastructure/auth/oidc";
import { WebAuthBoundary } from "./auth";
import type { WebRuntime } from "./runtime";

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
    !settings.OIDC_CLIENT_SECRET_FILE ||
    !settings.OIDC_ARCHIVE_ID
  )
    throw new Error("OIDC web configuration is incomplete");
  const secret = readFileSync(settings.OIDC_CLIENT_SECRET_FILE, "utf8").trim();
  if (!secret) throw new Error("OIDC client secret file is empty");
  const prisma = new PrismaClient();
  const reads = new ArchiveReadService(new PrismaReadPersistence(prisma), new CursorCodec(secret));
  return {
    auth: new WebAuthBoundary(
      new OidcAuth(
        new HttpOidcProvider(
          settings.OIDC_ISSUER,
          settings.OIDC_CLIENT_ID,
          secret,
          settings.OIDC_REDIRECT_URI,
        ),
        new PrismaPrincipalDirectory(prisma, settings.OIDC_ISSUER, settings.OIDC_ARCHIVE_ID),
        new SessionStore(),
      ),
      "/",
    ),
    reads: {
      listConversations: (query) => reads.listConversations(query),
      listMessages: (query) => reads.listMessages(query),
      search: (query) => reads.search(query),
      archiveHealth: (query) =>
        new ArchiveHealthService(new PrismaHealthReadPersistence(prisma)).getArchiveHealth(query),
      archiveStatistics: (query) =>
        new ArchiveStatisticsService(new PrismaStatisticsPersistence(prisma)).getStatistics(query),
    },
    media: new PrismaMediaDelivery(prisma, `${process.env.ECHOHOARD_DATA_DIR ?? "/data"}/media`),
  };
}
