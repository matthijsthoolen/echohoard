import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { OidcAuth, SessionStore } from "../../application/auth.js";
import { ArchiveHealthService } from "../../application/health-reads.js";
import { ArchiveReadService, CursorCodec } from "../../application/reads.js";
import { ArchiveStatisticsService } from "../../application/statistics.js";
import { parseEnv } from "../../config/env.js";
import {
  PrismaHealthReadPersistence,
  PrismaReadPersistence,
  PrismaStatisticsPersistence,
} from "../../infrastructure/db/prisma-persistence.js";
import { PrismaMediaDelivery } from "../../infrastructure/db/media-delivery.js";
import { HttpOidcProvider, PrismaPrincipalDirectory } from "../../infrastructure/auth/oidc.js";
import { WebAuthBoundary } from "./auth.js";
import type { WebRuntime } from "./runtime.js";

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
    !settings.OIDC_SUBJECT ||
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
        new PrismaPrincipalDirectory(
          prisma,
          settings.OIDC_ISSUER,
          settings.OIDC_SUBJECT,
          settings.OIDC_ARCHIVE_ID,
        ),
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
