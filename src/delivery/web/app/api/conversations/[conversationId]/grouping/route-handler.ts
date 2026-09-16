import type { ConversationGroupingService } from "../../../../../../../application/conversation-grouping";
import type { WebRuntime } from "../../../../../runtime";

export interface GroupingRouteDependencies {
  readonly getRuntime: () =>
    | {
        readonly auth: Pick<WebRuntime["auth"], "principalForRequest"> &
          Partial<Pick<WebRuntime["auth"], "lockedPrincipal">>;
        readonly grouping?: ConversationGroupingService;
      }
    | undefined;
}
type Context = {
  readonly params:
    | { readonly conversationId: string }
    | Promise<{ readonly conversationId: string }>;
};
type Body = {
  action: "merge" | "unmerge";
  sourceConversationIds: string[];
  expectedVersion: number;
  auditId?: string;
  reason?: string;
  idempotencyKey?: string;
};

export function createGroupingRoute({ getRuntime }: GroupingRouteDependencies) {
  return async function groupingRoute(request: Request, context: Context): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();
    if (!runtime.grouping)
      return Response.json({ error: "Conversation grouping unavailable" }, { status: 503 });
    const { conversationId } = await context.params;
    const body = request.method === "POST" ? await readBody(request) : undefined;
    const requestedIds = body?.sourceConversationIds ?? [];
    if (request.method === "POST" && (!body || !Array.isArray(body.sourceConversationIds)))
      return invalid("Invalid grouping request");
    const authorizedConversationIds = await authorizeLockedIds(
      runtime.auth,
      request,
      principal.archiveId,
      [conversationId, ...requestedIds],
    );
    if (request.method === "GET") {
      try {
        const state = await runtime.grouping.getState(principal.archiveId, conversationId, {
          authorizedConversationIds,
        });
        return Response.json(state, { headers: { "Cache-Control": "private, no-store" } });
      } catch {
        return Response.json({ error: "Grouping state unavailable" }, { status: 404 });
      }
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (
      !body ||
      (body.action !== "merge" && body.action !== "unmerge") ||
      !Array.isArray(body.sourceConversationIds) ||
      !body.sourceConversationIds.every((id) => typeof id === "string") ||
      !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion < 0
    )
      return invalid("Invalid grouping request");
    try {
      const result = await runtime.grouping[body.action]({
        archiveId: principal.archiveId,
        targetConversationId: conversationId,
        sourceConversationIds: body.sourceConversationIds,
        expectedVersion: body.expectedVersion,
        actor: principal.userId,
        reason:
          body.reason ??
          (body.action === "merge"
            ? "Owner merged selected source chats"
            : "Owner reversed a source-chat merge"),
        idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
        ...(body.auditId ? { auditId: body.auditId } : {}),
        uiAccess: { authorizedConversationIds },
      });
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grouping failed";
      const conflict = message.includes("stale") || message.includes("locked");
      const unavailable = message.includes("unavailable");
      return Response.json(
        {
          error: conflict
            ? "Conversation changed; reload before retrying"
            : unavailable
              ? "Grouping state unavailable"
              : "Grouping failed",
        },
        { status: conflict ? 409 : unavailable ? 404 : 400 },
      );
    }
  };
}
async function readBody(request: Request): Promise<Body | undefined> {
  try {
    return (await request.json()) as Body;
  } catch {
    return undefined;
  }
}
async function authorizeLockedIds(
  auth: Pick<WebRuntime["auth"], "principalForRequest"> &
    Partial<Pick<WebRuntime["auth"], "lockedPrincipal">>,
  request: Request,
  archiveId: string,
  ids: readonly string[],
): Promise<readonly string[]> {
  if (!auth.lockedPrincipal) return [];
  const authorized = await Promise.all(
    ids.map((id) => auth.lockedPrincipal!(request, archiveId, id)),
  );
  return ids.filter((_id, index) => authorized[index] !== null);
}
function invalid(error: string): Response {
  return Response.json({ error }, { status: 400 });
}
function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}
