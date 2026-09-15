import {
  OidcAuth,
  type ArchivePrincipal,
  type AuthBootstrapState,
} from "../../application/auth.js";
import { createHash } from "node:crypto";
import { renderErrorDocument } from "./error-document";
import { noopAuthDiagnostic, type AuthDiagnostic } from "../../application/auth-diagnostics";

const STATE_COOKIE = "echohoard_oidc_state";
const NONCE_COOKIE = "echohoard_oidc_nonce";
const VERIFIER_COOKIE = "echohoard_oidc_verifier";
const SESSION_COOKIE = "echohoard_session";
const cookieOptions = "Path=/; HttpOnly; SameSite=Lax; Secure";

export type AuthResponse = Response;

function randomToken(): string {
  return crypto.randomUUID();
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken() + randomToken();
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return { verifier, challenge };
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const value of header.split(";")) {
    const [key, ...parts] = value.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

function clearCookie(name: string): string {
  return `${name}=; ${cookieOptions}; Max-Age=0`;
}

export class WebAuthBoundary {
  constructor(
    private readonly auth: OidcAuth,
    private readonly callbackUrl: string,
    private readonly diagnostic: AuthDiagnostic = noopAuthDiagnostic,
  ) {}

  login(): AuthResponse {
    const state = randomToken();
    const nonce = randomToken();
    const pkce = pkcePair();
    const location = this.auth.login(state, nonce, pkce.challenge);
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Set-Cookie": `${STATE_COOKIE}=${encodeURIComponent(state)}; ${cookieOptions}; Max-Age=600, ${NONCE_COOKIE}=${encodeURIComponent(nonce)}; ${cookieOptions}; Max-Age=600, ${VERIFIER_COOKIE}=${encodeURIComponent(pkce.verifier)}; ${cookieOptions}; Max-Age=600`,
      },
    });
  }

  async bootstrapState(): Promise<AuthBootstrapState> {
    return this.auth.bootstrapState();
  }

  async callback(request: Request): Promise<AuthResponse> {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const expectedState = readCookie(request, STATE_COOKIE);
    const code = url.searchParams.get("code");
    const nonce = readCookie(request, NONCE_COOKIE);
    const verifier = readCookie(request, VERIFIER_COOKIE);
    if (!state || !expectedState || state !== expectedState || !code || !nonce) {
      this.diagnostic("oidc.callback.request-rejected", {
        state_present: Boolean(state),
        expected_state_present: Boolean(expectedState),
        state_matches: Boolean(state && expectedState && state === expectedState),
        code_present: Boolean(code),
        nonce_present: Boolean(nonce),
        verifier_present: Boolean(verifier),
      });
      return browserError("bad-request", 400);
    }
    const session = await this.auth.callback(code, nonce, verifier);
    if (!session) {
      this.diagnostic("oidc.callback.browser-denied", { status: 403 });
      return browserError("access-denied", 403);
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: this.callbackUrl,
        "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(session)}; ${cookieOptions}; Max-Age=3600, ${clearCookie(STATE_COOKIE)}, ${clearCookie(NONCE_COOKIE)}, ${clearCookie(VERIFIER_COOKIE)}`,
      },
    });
  }

  async logout(request: Request): Promise<AuthResponse> {
    await this.auth.logout(readCookie(request, SESSION_COOKIE));
    return new Response(null, {
      status: 302,
      headers: { Location: "/", "Set-Cookie": clearCookie(SESSION_COOKIE) },
    });
  }

  async principal(request: Request, archiveId: string): Promise<ArchivePrincipal | null> {
    return this.auth.validate(readCookie(request, SESSION_COOKIE), archiveId);
  }

  /** Resolve the session principal before selecting any archive-scoped read.
   * Callers must use the returned archiveId rather than trusting request input. */
  async principalForRequest(request: Request): Promise<ArchivePrincipal | null> {
    return this.auth.validate(readCookie(request, SESSION_COOKIE));
  }

  async approveIdentity(request: Request, issuer: string, subject: string): Promise<AuthResponse> {
    const principal = await this.principalForRequest(request);
    if (!principal || principal.role !== "admin")
      return Response.json({ error: "Administrator approval required" }, { status: 403 });
    const approved = await this.auth.approveIdentity(principal, issuer, subject);
    return approved
      ? Response.json({ approved: true }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Identity approval denied" }, { status: 403 });
  }

  async pendingIdentities(request: Request): Promise<AuthResponse> {
    const principal = await this.principalForRequest(request);
    if (!principal || principal.role !== "admin")
      return Response.json({ error: "Administrator approval required" }, { status: 403 });
    const identities = await this.auth.listPendingIdentities(principal);
    return Response.json({ identities }, { headers: { "Cache-Control": "no-store" } });
  }
}

function browserError(kind: "access-denied" | "bad-request", status: number): Response {
  return new Response(renderErrorDocument(kind), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

export { NONCE_COOKIE, SESSION_COOKIE, STATE_COOKIE, VERIFIER_COOKIE };
