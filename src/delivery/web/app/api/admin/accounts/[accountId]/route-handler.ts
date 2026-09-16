import type { AccountSettingsServicePort } from "../../../../../../../application/account-pairing.js";
import type { WebRuntime } from "../../../../../runtime.js";

type Context = { readonly params: Promise<{ readonly accountId: string }> };
type Runtime = Pick<WebRuntime, "auth"> & {
  readonly accountSettings?: Pick<AccountSettingsServicePort, "read" | "pause" | "resume">;
};

export interface AdminAccountRouteDependencies {
  readonly getRuntime: () => Runtime | undefined;
}

export function createAdminAccountGetRoute({ getRuntime }: AdminAccountRouteDependencies) {
  return async function GET(request: Request, context: Context): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.accountSettings) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    const { accountId } = await context.params;
    try {
      const account = await runtime.accountSettings.read(principal.archiveId, accountId);
      return account ? json(account) : error("Account not found", 404);
    } catch {
      return unavailable();
    }
  };
}

export function createAdminAccountActionRoute({ getRuntime }: AdminAccountRouteDependencies) {
  return async function POST(request: Request, context: Context): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.accountSettings) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    const input = await parseAction(request);
    if (!input) return error("Invalid account action", 400);
    const { accountId } = await context.params;
    try {
      const account =
        input.action === "pause"
          ? await runtime.accountSettings.pause(principal.archiveId, accountId, input.confirm)
          : await runtime.accountSettings.resume(principal.archiveId, accountId);
      return json(account);
    } catch (error) {
      return mapError(error);
    }
  };
}

async function parseAction(
  request: Request,
): Promise<{ readonly action: "pause" | "resume"; readonly confirm: boolean } | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const action = "action" in body ? body.action : undefined;
    const confirm = "confirm" in body ? body.confirm : false;
    if ((action !== "pause" && action !== "resume") || typeof confirm !== "boolean") return null;
    return { action, confirm };
  } catch {
    return null;
  }
}

function json(value: unknown): Response {
  return Response.json(value, { headers: { "Cache-Control": "private, no-store" } });
}

function mapError(caught: unknown): Response {
  const message = caught instanceof Error ? caught.message : "";
  if (message === "account not found") return error(message, 404);
  if (message === "pause confirmation required") return error(message, 409);
  return unavailable();
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
