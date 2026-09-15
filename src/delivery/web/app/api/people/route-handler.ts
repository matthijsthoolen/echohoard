import {
  InvalidReadRequestError,
  MAX_CURSOR_LENGTH,
  MAX_READ_LIMIT,
  type PersonRead,
  type ReadPage,
} from "../../../../../application/reads";
import type { WebRuntime } from "../../../runtime";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_SEARCH_LENGTH = 500;

export interface PeopleRouteDependencies {
  readonly getRuntime: () => PeopleRouteRuntime | undefined;
}

export interface PeopleRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: Pick<WebRuntime["reads"], "listPeople">;
}

export function createPeopleRoute({ getRuntime }: PeopleRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();

    const parsed = parseQuery(new URL(request.url).searchParams);
    if (parsed.ok === false) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      const page = await runtime.reads.listPeople({
        archiveId: principal.archiveId,
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
        ...(parsed.search ? { search: parsed.search } : {}),
      });
      return Response.json(toResponse(page), { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof InvalidReadRequestError)
        return Response.json({ error: "Invalid people page" }, { status: 400 });
      return Response.json({ error: "People list unavailable" }, { status: 500 });
    }
  };
}

function parseQuery(params: URLSearchParams):
  | {
      readonly ok: true;
      readonly limit: number;
      readonly cursor?: string;
      readonly search?: string;
    }
  | { readonly ok: false; readonly error: string } {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_READ_LIMIT}` };
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)
    return { ok: false, error: "cursor is too long" };
  const search = params.get("search") ?? undefined;
  if (search !== undefined && search.length > MAX_SEARCH_LENGTH)
    return { ok: false, error: "search is too long" };
  return { ok: true, limit, ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) };
}

function toResponse(page: ReadPage<PersonRead>) {
  return {
    items: page.items.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      identityCount: person.identityCount,
    })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
  };
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}
