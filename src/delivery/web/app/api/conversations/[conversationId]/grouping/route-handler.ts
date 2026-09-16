import type { ConversationGroupingService } from "../../../../../../../application/conversation-grouping";
import type { WebRuntime } from "../../../../../runtime";

export interface GroupingRouteDependencies {
  readonly getRuntime: () =>
    | (Pick<WebRuntime, "auth"> & { readonly grouping?: ConversationGroupingService })
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
    if (request.method === "GET") {
      try {
        const state = await runtime.grouping.getState(principal.archiveId, conversationId);
        return Response.json(state, { headers: { "Cache-Control": "private, no-store" } });
      } catch {
        return Response.json({ error: "Grouping state unavailable" }, { status: 404 });
      }
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await readBody(request);
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
      });
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grouping failed";
      const conflict = message.includes("stale") || message.includes("locked");
      return Response.json(
        { error: conflict ? "Conversation changed; reload before retrying" : "Grouping failed" },
        { status: conflict ? 409 : 400 },
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
function invalid(error: string): Response {
  return Response.json({ error }, { status: 400 });
}
function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}
