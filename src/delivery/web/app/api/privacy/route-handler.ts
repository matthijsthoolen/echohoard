import type {
  ConversationMcpAccess,
  ConversationUiVisibility,
} from "../../../../../application/conversation-privacy";
import type { WebRuntime } from "../../../runtime";

export interface PrivacyRouteDependencies {
  readonly getRuntime: () => PrivacyRouteRuntime | undefined;
}

export interface PrivacyRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly conversationPrivacy?: WebRuntime["conversationPrivacy"];
}

export function createPrivacyRoute({ getRuntime }: PrivacyRouteDependencies) {
  return async function handler(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return jsonError("Service unavailable", 503);
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return jsonError("Authentication required", 401);
    const conversationPrivacy = runtime.conversationPrivacy;
    if (!conversationPrivacy) return jsonError("Service unavailable", 503);
    try {
      if (request.method === "GET") {
        const policies = await conversationPrivacy.list(principal.archiveId);
        return Response.json(
          {
            policies: policies.map(({ archiveId, conversationId, uiVisibility, mcpAccess }) => ({
              archiveId,
              conversationId,
              uiVisibility,
              mcpAccess,
            })),
          },
          { headers: noStore() },
        );
      }
      if (request.method !== "PATCH") return jsonError("Method not allowed", 405);
      const body = (await request.json()) as Record<string, unknown>;
      const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
      const uiVisibility = body.uiVisibility as ConversationUiVisibility | undefined;
      const mcpAccess = body.mcpAccess as ConversationMcpAccess | undefined;
      const result = await conversationPrivacy.updatePolicy({
        archiveId: principal.archiveId,
        conversationId,
        actorId: principal.userId,
        ...(uiVisibility ? { uiVisibility } : {}),
        ...(mcpAccess ? { mcpAccess } : {}),
      });
      return Response.json({ policy: result.policy }, { headers: noStore() });
    } catch {
      return jsonError("Privacy settings unavailable", 400);
    }
  };
}

function noStore(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStore() });
}
