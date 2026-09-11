import {
  InvalidReadRequestError,
  MAX_CURSOR_LENGTH,
  MAX_READ_LIMIT,
  type MessageDirection,
  type ReadPage,
  type SearchMediaType,
  type SearchQuery,
  type SearchResultRead,
} from "../../../../../application/reads";
import type { WebRuntime } from "../../../runtime";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_FILTER_LENGTH = 5000;
const MEDIA_TYPES: readonly SearchMediaType[] = ["image", "video", "audio", "document", "other"];
const DIRECTIONS: readonly MessageDirection[] = ["sent", "received", "unknown"];

export interface SearchRouteDependencies {
  readonly getRuntime: () => SearchRouteRuntime | undefined;
}

export interface SearchRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: Pick<WebRuntime["reads"], "search">;
}

export function createSearchRoute({ getRuntime }: SearchRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();

    const parsed = parseQuery(new URL(request.url).searchParams);
    if (parsed.ok === false) return invalid(parsed.error);
    try {
      const page = await runtime.reads.search({ archiveId: principal.archiveId, ...parsed.query });
      return Response.json(toResponse(page), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof InvalidReadRequestError) return invalid("Invalid search request");
      return Response.json({ error: "Search unavailable" }, { status: 500 });
    }
  };
}

function parseQuery(
  params: URLSearchParams,
):
  | { readonly ok: true; readonly query: Omit<SearchQuery, "archiveId"> }
  | { readonly ok: false; readonly error: string } {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_READ_LIMIT}` };
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)
    return { ok: false, error: "cursor is too long" };
  const direction = params.get("pageDirection") ?? "forward";
  if (direction !== "forward" && direction !== "backward")
    return { ok: false, error: "pageDirection is invalid" };
  const senderDirection = params.get("direction") ?? undefined;
  if (senderDirection !== undefined && !DIRECTIONS.includes(senderDirection as MessageDirection))
    return { ok: false, error: "direction is invalid" };
  const mediaType = params.get("media") ?? params.get("mediaType") ?? undefined;
  if (mediaType !== undefined && !MEDIA_TYPES.includes(mediaType as SearchMediaType))
    return { ok: false, error: "media is invalid" };

  const values = {
    query: params.get("q") ?? params.get("query") ?? undefined,
    conversationId: params.get("conversation") ?? params.get("conversationId") ?? undefined,
    personId: params.get("person") ?? params.get("personId") ?? undefined,
    senderDirection: senderDirection as MessageDirection | undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    mediaType: mediaType as SearchMediaType | undefined,
    fuzzyName: params.get("name") ?? undefined,
    fuzzyText: params.get("text") ?? undefined,
  } satisfies Omit<SearchQuery, "archiveId">;
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value.length > MAX_FILTER_LENGTH)
      return { ok: false, error: `${name} is too long` };
  }
  if (values.from && !Number.isFinite(Date.parse(values.from)))
    return { ok: false, error: "from is invalid" };
  if (values.to && !Number.isFinite(Date.parse(values.to)))
    return { ok: false, error: "to is invalid" };
  if (values.from && values.to && Date.parse(values.from) > Date.parse(values.to))
    return { ok: false, error: "from must be before to" };
  return {
    ok: true,
    query: {
      limit,
      direction: direction as "forward" | "backward",
      ...(cursor ? { cursor } : {}),
      ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
    } as Omit<SearchQuery, "archiveId">,
  };
}

function toResponse(page: ReadPage<SearchResultRead>) {
  return {
    items: page.items.map((result) => ({
      id: result.id,
      kind: result.kind,
      ...(result.score === undefined ? {} : { score: result.score }),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      ...(result.sentAt ? { sentAt: result.sentAt } : {}),
    })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
  };
}

function invalid(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}
