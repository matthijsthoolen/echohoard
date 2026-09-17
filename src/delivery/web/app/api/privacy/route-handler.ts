import type {
  ConversationMcpAccess,
  ConversationUiVisibility,
} from "../../../../../application/conversation-privacy";
import type { WebRuntime } from "../../../runtime";

export interface PrivacyRouteDependencies {
  readonly getRuntime: () => PrivacyRouteRuntime | undefined;
}

export interface PrivacyRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest"> &
    Partial<Pick<WebRuntime["auth"], "grantedConversationIds">>;
  readonly conversationPrivacy?: WebRuntime["conversationPrivacy"];
}

export function createPrivacyRoute({ getRuntime }: PrivacyRouteDependencies) {
  return async function handler(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return jsonError("Service unavailable", 503);
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return jsonError("Authentication required", 401);
    if (new URL(request.url).searchParams.get("view") !== "privacy-management")
      return jsonError("Privacy settings unavailable", 403);
    const conversationPrivacy = runtime.conversationPrivacy;
    if (!conversationPrivacy) return jsonError("Service unavailable", 503);
    try {
      if (request.method === "GET") {
        const policies = await conversationPrivacy.list(principal.archiveId);
        const granted =
          (await runtime.auth.grantedConversationIds?.(request, principal.archiveId)) ?? [];
        return Response.json(
          {
            policies: policies
              .filter(
                ({ uiVisibility, conversationId }) =>
                  uiVisibility !== "locked" || granted.includes(conversationId),
              )
              .map(({ archiveId, conversationId, uiVisibility, mcpAccess }) => ({
                archiveId,
                conversationId,
                uiVisibility,
                mcpAccess,
              })),
            lockedFolder: { available: true, unlocked: granted.length > 0 },
          },
          { headers: noStore() },
        );
      }
      if (request.method !== "PATCH") return jsonError("Method not allowed", 405);
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.unlockHandle === "string")
        return jsonError("Privacy settings unavailable", 400);
      const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
      const uiVisibility = body.uiVisibility as ConversationUiVisibility | undefined;
      const mcpAccess = body.mcpAccess as ConversationMcpAccess | undefined;
      const existing = (await conversationPrivacy.list(principal.archiveId)).find(
        (policy) => policy.conversationId === conversationId,
      );
      const granted =
        (await runtime.auth.grantedConversationIds?.(request, principal.archiveId)) ?? [];
      if (existing?.uiVisibility === "locked" && !granted.includes(conversationId))
        return jsonError("Privacy settings unavailable", 400);
      const result = await conversationPrivacy.updatePolicy({
        archiveId: principal.archiveId,
        conversationId,
        actorId: principal.userId,
        ...(uiVisibility ? { uiVisibility } : {}),
        ...(mcpAccess ? { mcpAccess } : {}),
      });
      return Response.json(
        { policy: result.policy },
        {
          headers: noStore(),
        },
      );
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
