import type {
  ConversationPrivacyPolicy,
  ConversationMcpAccess,
  ConversationUiVisibility,
} from "../../../../../application/conversation-privacy";
import type { WebRuntime } from "../../../runtime";

export interface PrivacyRouteDependencies {
  readonly getRuntime: () => PrivacyRouteRuntime | undefined;
}

export interface PrivacyRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest"> &
    Partial<Pick<WebRuntime["auth"], "createUnlockHandle" | "resolveUnlockHandle">>;
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
            policies: await Promise.all(
              policies.map(async ({ archiveId, conversationId, uiVisibility, mcpAccess }) => {
                if (uiVisibility !== "locked")
                  return { archiveId, conversationId, uiVisibility, mcpAccess };
                const unlockHandle = await runtime.auth.createUnlockHandle?.(
                  request,
                  archiveId,
                  conversationId,
                );
                return unlockHandle ? { uiVisibility, mcpAccess, unlockHandle } : { uiVisibility };
              }),
            ),
          },
          { headers: noStore() },
        );
      }
      if (request.method !== "PATCH") return jsonError("Method not allowed", 405);
      const body = (await request.json()) as Record<string, unknown>;
      const conversationHandle =
        typeof body.unlockHandle === "string" ? body.unlockHandle : undefined;
      const resolved = conversationHandle
        ? await runtime.auth.resolveUnlockHandle?.(request, conversationHandle)
        : undefined;
      const conversationId =
        resolved?.conversationId ??
        (typeof body.conversationId === "string" ? body.conversationId : "");
      if (conversationHandle && !resolved) return jsonError("Privacy settings unavailable", 400);
      const uiVisibility = body.uiVisibility as ConversationUiVisibility | undefined;
      const mcpAccess = body.mcpAccess as ConversationMcpAccess | undefined;
      const result = await conversationPrivacy.updatePolicy({
        archiveId: resolved?.archiveId ?? principal.archiveId,
        conversationId,
        actorId: principal.userId,
        ...(uiVisibility ? { uiVisibility } : {}),
        ...(mcpAccess ? { mcpAccess } : {}),
      });
      return Response.json(
        { policy: await responsePolicy(request, runtime.auth, result.policy) },
        {
          headers: noStore(),
        },
      );
    } catch {
      return jsonError("Privacy settings unavailable", 400);
    }
  };
}

async function responsePolicy(
  request: Request,
  auth: PrivacyRouteRuntime["auth"],
  policy: ConversationPrivacyPolicy,
) {
  if (policy.uiVisibility !== "locked") return policy;
  const unlockHandle = await auth.createUnlockHandle?.(
    request,
    policy.archiveId,
    policy.conversationId,
  );
  return unlockHandle
    ? { uiVisibility: policy.uiVisibility, mcpAccess: policy.mcpAccess, unlockHandle }
    : { uiVisibility: policy.uiVisibility };
}

function noStore(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: noStore() });
}
