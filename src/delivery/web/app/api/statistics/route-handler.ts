import type {
  ArchiveStatisticsQuery,
  ArchiveStatisticsRead,
} from "../../../../../application/statistics";
import type { WebRuntime } from "../../../runtime";

const MAX_FILTER_LENGTH = 200;

export interface StatisticsRouteDependencies {
  readonly getRuntime: () => StatisticsRouteRuntime | undefined;
}

export interface StatisticsRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: {
    readonly archiveStatistics?: (query: {
      readonly archiveId: string;
      readonly from?: string;
      readonly to?: string;
      readonly bucket?: "day" | "week" | "month";
      readonly limit?: number;
      readonly unifiedConversationId?: string;
      readonly sourceAccountId?: string;
    }) => Promise<ArchiveStatisticsRead>;
  };
}

/** Authenticated archive statistics. Archive selection is always derived from
 * the session principal; request parameters cannot switch archives. */
export function createStatisticsRoute({ getRuntime }: StatisticsRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();
    if (!runtime.reads.archiveStatistics) return unavailable();
    const parsed = parseQuery(new URL(request.url).searchParams);
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      const statistics = await runtime.reads.archiveStatistics({
        archiveId: principal.archiveId,
        ...parsed.query,
      });
      return Response.json(statistics, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch {
      return Response.json({ error: "Archive statistics unavailable" }, { status: 500 });
    }
  };
}

function parseQuery(
  params: URLSearchParams,
):
  | { readonly ok: true; readonly query: Omit<ArchiveStatisticsQuery, "archiveId"> }
  | { readonly ok: false; readonly error: string } {
  const values = {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    bucket: params.get("bucket") ?? undefined,
    limit: params.get("limit") === null ? undefined : Number(params.get("limit")),
    unifiedConversationId:
      params.get("unifiedConversation") ?? params.get("unifiedConversationId") ?? undefined,
    sourceAccountId: params.get("sourceAccount") ?? params.get("sourceAccountId") ?? undefined,
  };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && value.length > MAX_FILTER_LENGTH)
      return { ok: false, error: `${name} is too long` };
  }
  if (values.bucket !== undefined && !["day", "week", "month"].includes(values.bucket))
    return { ok: false, error: "bucket is invalid" };
  if (
    values.limit !== undefined &&
    (!Number.isSafeInteger(values.limit) || values.limit < 1 || values.limit > 100)
  )
    return { ok: false, error: "limit is invalid" };
  if (values.from && !Number.isFinite(Date.parse(values.from)))
    return { ok: false, error: "from is invalid" };
  if (values.to && !Number.isFinite(Date.parse(values.to)))
    return { ok: false, error: "to is invalid" };
  if (values.from && values.to && Date.parse(values.from) >= Date.parse(values.to))
    return { ok: false, error: "from must be before to" };
  return {
    ok: true,
    query: Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as Omit<ArchiveStatisticsQuery, "archiveId">,
  };
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

function unavailable(): Response {
  return Response.json({ error: "Archive statistics unavailable" }, { status: 503 });
}
