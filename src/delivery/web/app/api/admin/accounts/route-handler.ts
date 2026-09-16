import type { AccountSettingsServicePort } from "../../../../../../application/account-pairing.js";
import type { WebRuntime } from "../../../../runtime.js";

export interface AdminAccountsRouteDependencies {
  readonly getRuntime: () =>
    | (Pick<WebRuntime, "auth"> & {
        readonly accountSettings?: Pick<AccountSettingsServicePort, "list">;
      })
    | undefined;
}

export function createAdminAccountsRoute({ getRuntime }: AdminAccountsRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.accountSettings) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    try {
      const accounts = await runtime.accountSettings.list(principal.archiveId);
      return Response.json({ accounts }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
      return unavailable();
    }
  };
}

function forbidden(): Response {
  return error("Administrator approval required", 403);
}

function unavailable(): Response {
  return error("Account settings unavailable", 503);
}

function error(message: string, status: number): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}
