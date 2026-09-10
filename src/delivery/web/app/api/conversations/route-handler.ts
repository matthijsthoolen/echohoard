import {
  InvalidReadRequestError,
  MAX_CURSOR_LENGTH,
  MAX_READ_LIMIT,
  type ConversationRead,
  type ReadPage,
} from "../../../../../application/reads";
import type { WebRuntime } from "../../../runtime";

const DEFAULT_PAGE_LIMIT = 50;

export interface ConversationRouteDependencies {
  readonly getRuntime: () => ConversationRouteRuntime | undefined;
}

export interface ConversationRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: Pick<WebRuntime["reads"], "listConversations">;
}

export function createConversationsRoute({ getRuntime }: ConversationRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();

    const principal = runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();

    const parsed = parseQuery(new URL(request.url).searchParams);
    if (parsed.ok === false) return Response.json({ error: parsed.error }, { status: 400 });

    try {
      const page = await runtime.reads.listConversations({
        archiveId: principal.archiveId,
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      });
      return Response.json(toResponse(page), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof InvalidReadRequestError)
        return Response.json({ error: "Invalid conversation page" }, { status: 400 });
      return Response.json({ error: "Conversation list unavailable" }, { status: 500 });
    }
  };
}

function parseQuery(
  params: URLSearchParams,
):
  | { readonly ok: true; readonly limit: number; readonly cursor?: string }
  | { readonly ok: false; readonly error: string } {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_READ_LIMIT}` };

  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)
    return { ok: false, error: "cursor is too long" };
  return { ok: true, limit, ...(cursor ? { cursor } : {}) };
}

function toResponse(page: ReadPage<ConversationRead>) {
  return {
    items: page.items.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      participantCount: conversation.participantCount,
      ...(conversation.lastMessageAt ? { lastMessageAt: conversation.lastMessageAt } : {}),
    })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
  };
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}
