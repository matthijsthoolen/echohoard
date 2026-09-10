import type { ArchiveHealthRead } from "../../../../../application/health-reads";
import type { WebRuntime } from "../../../runtime";

export interface HealthRouteDependencies {
  readonly getRuntime: () => HealthRouteRuntime | undefined;
}

export interface HealthRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: {
    readonly archiveHealth?: (query: { readonly archiveId: string }) => Promise<ArchiveHealthRead>;
  };
}

/** Authenticated archive evidence. The archive is selected exclusively from
 * the session principal; no query parameter can switch archives. */
export function createHealthRoute({ getRuntime }: HealthRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();
    if (!runtime.reads.archiveHealth) return unavailable();
    try {
      const health = await runtime.reads.archiveHealth({ archiveId: principal.archiveId });
      return Response.json(health, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch {
      return Response.json({ error: "Archive health unavailable" }, { status: 500 });
    }
  };
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

function unavailable(): Response {
  return Response.json({ error: "Archive health unavailable" }, { status: 503 });
}
