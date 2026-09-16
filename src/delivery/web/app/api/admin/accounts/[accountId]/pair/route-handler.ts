import type {
  AccountSettingsServicePort,
  PairingSessionRead,
} from "../../../../../../../../application/account-pairing.js";
import type { WebRuntime } from "../../../../../../runtime.js";

type Context = { readonly params: Promise<{ readonly accountId: string }> };
type Runtime = Pick<WebRuntime, "auth"> & {
  readonly accountSettings?: Pick<AccountSettingsServicePort, "beginPairing" | "pairingStatus">;
};

export interface AdminPairingRouteDependencies {
  readonly getRuntime: () => Runtime | undefined;
}

export function createAdminPairingRoute({ getRuntime }: AdminPairingRouteDependencies) {
  return async function POST(request: Request, context: Context): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.accountSettings) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    const input = await parseInput(request);
    if (!input) return error("Invalid pairing request", 400);
    try {
      const { accountId } = await context.params;
      return json(
        await runtime.accountSettings.beginPairing(principal.archiveId, accountId, input),
        201,
      );
    } catch (error) {
      return mapError(error);
    }
  };
}

export function createAdminPairingStatusRoute({ getRuntime }: AdminPairingRouteDependencies) {
  return async function GET(request: Request, context: Context): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.accountSettings) return unavailable();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal || principal.role !== "admin") return forbidden();
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId || sessionId.length > 128)
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    const { accountId } = await context.params;
    try {
      const pairing = await runtime.accountSettings.pairingStatus(
        principal.archiveId,
        accountId,
        sessionId,
      );
      return pairing ? json(pairing) : error("Pairing session not found", 404);
    } catch {
      return unavailable();
    }
  };
}

async function parseInput(
  request: Request,
): Promise<{ readonly confirm: boolean; readonly rePair: boolean } | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const confirm = "confirm" in body ? body.confirm : false;
    const rePair = "rePair" in body ? body.rePair : false;
    return typeof confirm === "boolean" && typeof rePair === "boolean" ? { confirm, rePair } : null;
  } catch {
    return null;
  }
}

function json(value: PairingSessionRead, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function mapError(caught: unknown): Response {
  const message = caught instanceof Error ? caught.message : "";
  if (message === "account not found") return error(message, 404);
  if (message.includes("confirmation required")) return error(message, 409);
  if (message === "pairing capacity reached") return error(message, 429);
  return unavailable();
}

function forbidden(): Response {
  return error("Administrator approval required", 403);
}

function unavailable(): Response {
  return error("Account pairing unavailable", 503);
}

function error(message: string, status: number): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}
