import type { ReadPorts } from "../../application/reads.js";
import type { ArchiveHealthRead } from "../../application/health-reads.js";
import type { ArchiveStatisticsRead } from "../../application/statistics.js";
import type { WebAuthBoundary } from "./auth.js";
import type { MediaDeliveryPort } from "../../application/media-delivery.js";
import type { LiveEventIntakeService } from "../../application/live-event-intake.js";
import type { TranscriptionSettingsService } from "../../application/transcription-catalog.js";
import type { AccountSettingsServicePort } from "../../application/account-pairing.js";
import type { ConversationGroupingService } from "../../application/conversation-grouping.js";
import { productionWebRuntime } from "./composition";

export type WebReadServices = Pick<
  ReadPorts,
  "listConversations" | "listPeople" | "listMessages" | "search"
> & {
  readonly archiveHealth?: (query: { readonly archiveId: string }) => Promise<ArchiveHealthRead>;
  readonly archiveStatistics?: (query: {
    readonly archiveId: string;
  }) => Promise<ArchiveStatisticsRead>;
};

export interface WebRuntime {
  readonly auth: WebAuthBoundary;
  readonly reads: WebReadServices;
  readonly media?: MediaDeliveryPort;
  readonly liveEventIntake?: LiveEventIntakeService;
  readonly transcription?: TranscriptionSettingsService;
  readonly accountSettings?: AccountSettingsServicePort;
  readonly grouping?: ConversationGroupingService;
}

let activeRuntime: WebRuntime | undefined;

/**
 * The composition root supplies the authenticated services at process start.
 * Keeping this boundary explicit prevents route handlers from importing Prisma
 * and makes the delivery contract straightforward to test with fake services.
 */
export function configureWebRuntime(runtime: WebRuntime): void {
  activeRuntime = runtime;
}

export function getWebRuntime(): WebRuntime | undefined {
  if (!activeRuntime) {
    try {
      configureWebRuntime(productionWebRuntime());
    } catch {
      return undefined;
    }
  }
  return activeRuntime;
}
