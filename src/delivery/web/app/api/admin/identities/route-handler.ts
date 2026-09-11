import type { WebRuntime } from "../../../../runtime";

export interface AdminIdentityRouteDependencies {
  readonly getRuntime: () =>
    | { readonly auth: Pick<WebRuntime["auth"], "approveIdentity" | "pendingIdentities"> }
    | undefined;
}

export function createAdminIdentityApprovalRoute({ getRuntime }: AdminIdentityRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    const input = await parseInput(request);
    if (!input) return Response.json({ error: "Invalid identity" }, { status: 400 });
    try {
      return await runtime.auth.approveIdentity(request, input.issuer, input.subject);
    } catch {
      return unavailable();
    }
  };
}

export function createAdminIdentityListRoute({ getRuntime }: AdminIdentityRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    try {
      return await runtime.auth.pendingIdentities(request);
    } catch {
      return unavailable();
    }
  };
}

async function parseInput(
  request: Request,
): Promise<{ readonly issuer: string; readonly subject: string } | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const issuer = "issuer" in body && typeof body.issuer === "string" ? body.issuer : "";
    const subject = "subject" in body && typeof body.subject === "string" ? body.subject : "";
    if (!issuer || issuer.length > 2048 || !subject || subject.length > 512) return null;
    return { issuer, subject };
  } catch {
    return null;
  }
}

function unavailable(): Response {
  return new Response("Authentication is temporarily unavailable.", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
