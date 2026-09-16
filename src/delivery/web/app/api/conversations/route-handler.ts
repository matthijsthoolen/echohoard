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
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest"> & {
    readonly lockedPrincipal?: WebRuntime["auth"]["lockedPrincipal"];
  };
  readonly reads: Pick<WebRuntime["reads"], "listConversations">;
}

export function createConversationsRoute({ getRuntime }: ConversationRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();

    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();

    const parsed = parseQuery(new URL(request.url).searchParams);
    if (parsed.ok === false) return Response.json({ error: parsed.error }, { status: 400 });

    try {
      let query: Parameters<typeof runtime.reads.listConversations>[0] = {
        archiveId: principal.archiveId,
        limit: parsed.limit,
        ...(parsed.mode ? { uiAccess: { mode: parsed.mode } } : {}),
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      };
      if (parsed.mode === "locked" && parsed.conversationId) {
        const unlocked = await runtime.auth.lockedPrincipal?.(
          request,
          principal.archiveId,
          parsed.conversationId,
        );
        if (!unlocked) return Response.json({ error: "Conversation unavailable" }, { status: 404 });
        query = {
          ...query,
          uiAccess: { mode: "locked", authorizedConversationIds: [parsed.conversationId] },
        };
      }
      const page = await runtime.reads.listConversations(query);
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

function parseQuery(params: URLSearchParams):
  | {
      readonly ok: true;
      readonly limit: number;
      readonly cursor?: string;
      readonly mode?: "hidden" | "locked";
      readonly conversationId?: string;
    }
  | { readonly ok: false; readonly error: string } {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_READ_LIMIT}` };

  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)
    return { ok: false, error: "cursor is too long" };
  const mode = params.get("mode");
  if (mode !== null && mode !== "hidden" && mode !== "locked")
    return { ok: false, error: "mode is invalid" };
  const conversationId = params.get("conversationId") ?? undefined;
  return {
    ok: true,
    limit,
    ...(cursor ? { cursor } : {}),
    ...(mode === "hidden" || mode === "locked" ? { mode } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
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
