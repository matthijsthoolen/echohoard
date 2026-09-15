import { noopAuthDiagnostic, type AuthDiagnostic } from "./auth-diagnostics";

export type ArchivePrincipal = {
  userId: string;
  archiveId: string;
  subject: string;
  issuer: string;
  role?: "admin" | "member";
};
export type AuthBootstrapState = "setup" | "ready";
export type OidcClaims = { iss?: unknown; sub?: unknown; exp?: unknown; nonce?: unknown };
export type PendingIdentity = Readonly<{
  issuer: string;
  subject: string;
  createdAt: string;
}>;

export interface OidcProvider {
  authorizationUrl(state: string, nonce?: string, codeChallenge?: string): string;
  exchange(code: string, nonce?: string, codeVerifier?: string): Promise<OidcClaims>;
}

export interface PrincipalDirectory {
  findBySubject(issuer: string, subject: string): Promise<ArchivePrincipal | null>;
  bootstrapState?(): Promise<AuthBootstrapState>;
  approveIdentity?(input: {
    archiveId: string;
    approverIssuer: string;
    approverSubject: string;
    issuer: string;
    subject: string;
  }): Promise<boolean>;
  listPendingIdentities?(input: {
    archiveId: string;
    approverIssuer: string;
    approverSubject: string;
  }): Promise<readonly PendingIdentity[]>;
}

export interface SessionStore {
  create(principal: ArchivePrincipal): Promise<string>;
  get(token: string | undefined): Promise<ArchivePrincipal | null>;
  revoke(token: string | undefined): Promise<void>;
  cleanupExpired(limit: number): Promise<number>;
}

export class OidcAuth {
  constructor(
    private readonly provider: OidcProvider,
    private readonly directory: PrincipalDirectory,
    private readonly sessions: SessionStore,
    private readonly diagnostic: AuthDiagnostic = noopAuthDiagnostic,
  ) {}
  login(state: string, nonce?: string, codeChallenge?: string): string {
    return this.provider.authorizationUrl(state, nonce, codeChallenge);
  }
  async bootstrapState(): Promise<AuthBootstrapState> {
    return (await this.directory.bootstrapState?.()) ?? "ready";
  }
  async callback(
    code: string,
    expectedNonce?: string,
    codeVerifier?: string,
  ): Promise<string | null> {
    let claims: OidcClaims;
    try {
      claims = await this.provider.exchange(code, expectedNonce, codeVerifier);
    } catch {
      this.diagnostic("oidc.callback.exchange-error", {});
      return null;
    }
    const nonceMatches = expectedNonce === undefined || claims.nonce === expectedNonce;
    const expired = typeof claims.exp === "number" && claims.exp * 1000 <= Date.now();
    if (
      typeof claims.iss !== "string" ||
      typeof claims.sub !== "string" ||
      !nonceMatches ||
      expired
    ) {
      this.diagnostic("oidc.callback.claims-rejected", {
        issuer_present: typeof claims.iss === "string",
        subject_present: typeof claims.sub === "string",
        nonce_matches: nonceMatches,
        expired,
      });
      return null;
    }
    const principal = await this.directory.findBySubject(claims.iss, claims.sub);
    if (!principal) {
      this.diagnostic("oidc.callback.identity-not-admitted", {});
      return null;
    }
    await this.sessions.cleanupExpired(100);
    const session = await this.sessions.create(principal);
    this.diagnostic("oidc.callback.accepted", { role: principal.role ?? "unspecified" });
    return session;
  }
  async approveIdentity(
    principal: ArchivePrincipal,
    issuer: string,
    subject: string,
  ): Promise<boolean> {
    if (principal.role !== "admin" || !this.directory.approveIdentity) return false;
    return this.directory.approveIdentity({
      archiveId: principal.archiveId,
      approverIssuer: principal.issuer,
      approverSubject: principal.subject,
      issuer,
      subject,
    });
  }
  async listPendingIdentities(principal: ArchivePrincipal): Promise<readonly PendingIdentity[]> {
    if (principal.role !== "admin" || !this.directory.listPendingIdentities) return [];
    return this.directory.listPendingIdentities({
      archiveId: principal.archiveId,
      approverIssuer: principal.issuer,
      approverSubject: principal.subject,
    });
  }
  async validate(
    session: string | undefined,
    archiveId?: string,
  ): Promise<ArchivePrincipal | null> {
    const principal = await this.sessions.get(session);
    return principal && (!archiveId || principal.archiveId === archiveId) ? principal : null;
  }
  async logout(session: string | undefined): Promise<void> {
    await this.sessions.revoke(session);
  }
}

export const requireArchivePrincipal = async (
  auth: OidcAuth,
  session: string | undefined,
  archiveId: string,
): Promise<ArchivePrincipal> => {
  const principal = await auth.validate(session, archiveId);
  if (!principal) throw new Error("archive access denied");
  return principal;
};
