import {
  InvalidReadRequestError,
  MAX_CURSOR_LENGTH,
  MAX_READ_LIMIT,
  type MessageRead,
  type ReadPage,
} from "../../../../../../../application/reads";
import type { WebRuntime } from "../../../../../runtime";

const DEFAULT_PAGE_LIMIT = 50;

export interface MessageRouteDependencies {
  readonly getRuntime: () => MessageRouteRuntime | undefined;
}

export interface MessageRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly reads: Pick<WebRuntime["reads"], "listMessages">;
}

type MessageRouteContext = {
  readonly params:
    | { readonly conversationId: string }
    | Promise<{ readonly conversationId: string }>;
};

export function createMessagesRoute({ getRuntime }: MessageRouteDependencies) {
  return async function GET(request: Request, context: MessageRouteContext): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();

    const { conversationId } = await context.params;
    if (!conversationId?.trim()) return invalid("conversation is required");
    const parsed = parseQuery(new URL(request.url).searchParams);
    if (parsed.ok === false) return invalid(parsed.error);

    try {
      const page = await runtime.reads.listMessages({
        archiveId: principal.archiveId,
        conversationId,
        limit: parsed.limit,
        direction: parsed.direction,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      });
      return Response.json(toResponse(page), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof InvalidReadRequestError) return invalid("Invalid message page");
      return Response.json({ error: "Message timeline unavailable" }, { status: 500 });
    }
  };
}

function parseQuery(params: URLSearchParams):
  | {
      readonly ok: true;
      readonly limit: number;
      readonly direction: "forward" | "backward";
      readonly cursor?: string;
    }
  | { readonly ok: false; readonly error: string } {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_READ_LIMIT}` };
  const direction = params.get("direction") ?? "backward";
  if (direction !== "forward" && direction !== "backward")
    return { ok: false, error: "direction is invalid" };
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)
    return { ok: false, error: "cursor is too long" };
  return { ok: true, limit, direction, ...(cursor ? { cursor } : {}) };
}

function toResponse(page: ReadPage<MessageRead>) {
  return {
    items: page.items.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      ...(message.senderPersonId ? { senderPersonId: message.senderPersonId } : {}),
      sentAt: message.sentAt,
      ...(message.text !== undefined ? { text: message.text } : {}),
      attachmentCount: message.attachmentCount,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      direction: message.direction,
      messageType: message.messageType,
      ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      revisions: message.revisions,
      reactions: message.reactions,
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
