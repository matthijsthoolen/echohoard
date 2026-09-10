/** Archive statistics are deterministic, archive-scoped read models.  They
 * intentionally contain no interpretation of message content: direction is
 * the normalized metadata value, media type is derived from its MIME type,
 * and activity is a UTC calendar bucket.
 *
 * A message is published to statistics only when its provenance points at a
 * snapshot whose lifecycle and import job are both `completed`.  This is the
 * same transactional publication boundary used by the snapshot importer.
 * Date ranges are half-open [from, to), and bucket starts are UTC.
 */
export type StatisticsArchiveId = string;
export type StatisticsBucket = "day" | "week" | "month";
export type StatisticsMediaType = "image" | "video" | "audio" | "document" | "other" | "unknown";
export type StatisticsMediaAvailability = "available" | "missing" | "unsafe" | "unresolved";

export const DEFAULT_STATISTICS_BUCKET: StatisticsBucket = "day";
export const DEFAULT_STATISTICS_LIMIT = 20;
export const MAX_STATISTICS_LIMIT = 100;
export const MAX_ACTIVITY_BUCKETS = 366;

export interface ArchiveStatisticsQuery {
  readonly archiveId: StatisticsArchiveId;
  /** Inclusive UTC ISO timestamp. */
  readonly from?: string;
  /** Exclusive UTC ISO timestamp. */
  readonly to?: string;
  readonly bucket?: StatisticsBucket;
  readonly limit?: number;
}

export interface ArchiveStatisticsRead {
  readonly archiveId: StatisticsArchiveId;
  readonly range: {
    readonly from?: string;
    readonly to?: string;
    readonly bucket: StatisticsBucket;
  };
  readonly totals: {
    readonly messages: number;
    readonly conversations: number;
    readonly people: number;
    /** Distinct attachment records referenced by published messages. */
    readonly media: number;
  };
  readonly mediaByTypeAndState: readonly {
    readonly type: StatisticsMediaType;
    readonly availability: StatisticsMediaAvailability;
    readonly count: number;
  }[];
  readonly direction: {
    readonly sent: number;
    readonly received: number;
    readonly unknown: number;
  };
  readonly activity: readonly {
    readonly bucketStart: string;
    readonly count: number;
  }[];
  readonly mostActiveConversations: readonly {
    readonly conversationId: string;
    readonly title?: string;
    readonly messageCount: number;
    readonly lastMessageAt?: string;
  }[];
}

export interface StatisticsPersistenceInput {
  readonly archiveId: string;
  readonly from?: string;
  readonly to?: string;
  readonly bucket: StatisticsBucket;
  readonly limit: number;
}

export interface StatisticsPersistenceResult {
  readonly totals: ArchiveStatisticsRead["totals"];
  readonly mediaByTypeAndState: ArchiveStatisticsRead["mediaByTypeAndState"];
  readonly direction: ArchiveStatisticsRead["direction"];
  readonly activity: ArchiveStatisticsRead["activity"];
  readonly mostActiveConversations: ArchiveStatisticsRead["mostActiveConversations"];
}

export interface StatisticsPersistencePort {
  getStatistics(input: StatisticsPersistenceInput): Promise<StatisticsPersistenceResult>;
}

export class ArchiveStatisticsService {
  public constructor(private readonly persistence: StatisticsPersistencePort) {}

  public async getStatistics(query: ArchiveStatisticsQuery): Promise<ArchiveStatisticsRead> {
    const input = validateStatisticsQuery(query);
    const result = await this.persistence.getStatistics(input);
    return {
      archiveId: input.archiveId,
      range: {
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        bucket: input.bucket,
      },
      totals: result.totals,
      mediaByTypeAndState: result.mediaByTypeAndState,
      direction: result.direction,
      activity: result.activity,
      mostActiveConversations: result.mostActiveConversations,
    };
  }

  /** Short alias for delivery adapters and future MCP statistics mapping. */
  public getArchiveStatistics(query: ArchiveStatisticsQuery): Promise<ArchiveStatisticsRead> {
    return this.getStatistics(query);
  }
}

function validateStatisticsQuery(query: ArchiveStatisticsQuery): StatisticsPersistenceInput {
  if (!query.archiveId.trim()) throw new Error("archiveId is required");
  const from = normalizeDate(query.from, "from");
  const to = normalizeDate(query.to, "to");
  if (from && to && from >= to) throw new Error("from must be earlier than to");
  const bucket = query.bucket ?? DEFAULT_STATISTICS_BUCKET;
  if (bucket !== "day" && bucket !== "week" && bucket !== "month")
    throw new Error("bucket is invalid");
  const limit = query.limit ?? DEFAULT_STATISTICS_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STATISTICS_LIMIT)
    throw new Error(`limit must be an integer from 1 to ${MAX_STATISTICS_LIMIT}`);
  return {
    archiveId: query.archiveId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    bucket,
    limit,
  };
}

function normalizeDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid ISO timestamp`);
  return date.toISOString();
}
