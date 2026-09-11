import type { ArchiveStatisticsRead } from "../../../../../application/statistics";
import type { WebRuntime } from "../../../runtime";

export interface StatisticsRouteDependencies {
  readonly getRuntime: () => StatisticsRouteRuntime | undefined;
}

export interface StatisticsRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: {
    readonly archiveStatistics?: (query: {
      readonly archiveId: string;
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
    try {
      const statistics = await runtime.reads.archiveStatistics({ archiveId: principal.archiveId });
      return Response.json(statistics, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch {
      return Response.json({ error: "Archive statistics unavailable" }, { status: 500 });
    }
  };
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

function unavailable(): Response {
  return Response.json({ error: "Archive statistics unavailable" }, { status: 503 });
}
