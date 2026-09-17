import { noopAuthDiagnostic, type AuthDiagnostic } from "./auth-diagnostics";

export type ArchivePrincipal = {
  userId: string;
  archiveId: string;
  subject: string;
  issuer: string;
  role?: "admin" | "member";
};
export type AuthBootstrapState = "setup" | "ready";
export type OidcClaims = {
  iss?: unknown;
  sub?: unknown;
  exp?: unknown;
  nonce?: unknown;
  auth_time?: unknown;
};
export type OidcAuthorizationOptions = Readonly<{
  prompt?: "login";
  maxAge?: number;
}>;
export type PendingIdentity = Readonly<{
  issuer: string;
  subject: string;
  createdAt: string;
}>;

export interface OidcProvider {
  authorizationUrl(
    state: string,
    nonce?: string,
    codeChallenge?: string,
    options?: OidcAuthorizationOptions,
  ): string;
  exchange(code: string, nonce?: string, codeVerifier?: string): Promise<OidcClaims>;
}

export type UnlockChallenge = Readonly<{
  archiveId: string;
  conversationId: string;
}>;

export interface UnlockStore {
  createFolderChallenge?(input: {
    readonly state: string;
    readonly sessionToken: string;
    readonly archiveId: string;
  }): Promise<boolean>;
  createChallenge(input: {
    readonly state: string;
    readonly sessionToken: string;
    readonly archiveId: string;
    readonly conversationId: string;
  }): Promise<boolean>;
  findChallenge(input: {
    readonly state: string;
    readonly sessionToken: string;
  }): Promise<UnlockChallenge | null>;
  consumeChallenge(input: {
    readonly state: string;
    readonly sessionToken: string;
  }): Promise<boolean>;
  createGrant(input: {
    readonly sessionToken: string;
    readonly archiveId: string;
    readonly conversationId: string;
  }): Promise<string>;
  createGrantsForArchive?(input: {
    readonly sessionToken: string;
    readonly archiveId: string;
  }): Promise<string>;
  listGrantedConversationIds?(input: {
    readonly sessionToken: string;
    readonly archiveId: string;
  }): Promise<readonly string[]>;
  validateGrant(input: {
    readonly grantToken: string;
    readonly sessionToken: string;
    readonly archiveId: string;
    readonly conversationId: string;
  }): Promise<boolean>;
  revokeSession(sessionToken: string): Promise<void>;
  cleanupExpired(limit: number): Promise<number>;
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
    private readonly unlocks?: UnlockStore,
    private readonly recentAuthSeconds = 300,
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

  async beginUnlock(
    session: string | undefined,
    input: {
      readonly state: string;
      readonly nonce: string;
      readonly codeChallenge: string;
      readonly archiveId: string;
      readonly conversationId: string;
    },
  ): Promise<string | null> {
    const principal = await this.validate(session, input.archiveId);
    if (!principal || !this.unlocks) return null;
    const created = await this.unlocks.createChallenge({
      state: input.state,
      sessionToken: session!,
      archiveId: principal.archiveId,
      conversationId: input.conversationId,
    });
    if (!created) return null;
    await this.unlocks.cleanupExpired(100);
    return this.provider.authorizationUrl(input.state, input.nonce, input.codeChallenge, {
      prompt: "login",
      maxAge: 0,
    });
  }

  async beginFolderUnlock(
    session: string | undefined,
    input: {
      readonly state: string;
      readonly nonce: string;
      readonly codeChallenge: string;
      readonly archiveId: string;
    },
  ): Promise<string | null> {
    const principal = await this.validate(session, input.archiveId);
    if (!principal || !this.unlocks?.createFolderChallenge) return null;
    if (
      !(await this.unlocks.createFolderChallenge({
        state: input.state,
        sessionToken: session!,
        archiveId: principal.archiveId,
      }))
    )
      return null;
    return this.provider.authorizationUrl(input.state, input.nonce, input.codeChallenge, {
      prompt: "login",
      maxAge: 0,
    });
  }

  async completeUnlock(
    session: string | undefined,
    input: {
      readonly state: string;
      readonly code: string;
      readonly nonce: string;
      readonly codeVerifier: string;
    },
  ): Promise<string | null> {
    if (!session || !this.unlocks) return null;
    const principal = await this.validate(session);
    if (!principal) return null;
    const challenge = await this.unlocks.findChallenge({
      state: input.state,
      sessionToken: session,
    });
    if (!challenge || challenge.archiveId !== principal.archiveId) return null;
    let claims: OidcClaims;
    try {
      claims = await this.provider.exchange(input.code, input.nonce, input.codeVerifier);
    } catch {
      this.diagnostic("oidc.unlock.exchange-error", {});
      return null;
    }
    const valid =
      claims.iss === principal.issuer &&
      claims.sub === principal.subject &&
      claims.nonce === input.nonce &&
      isRecentAuthentication(claims.auth_time, this.recentAuthSeconds) &&
      (typeof claims.exp !== "number" || claims.exp * 1000 > Date.now());
    if (!valid) {
      this.diagnostic("oidc.unlock.claims-rejected", {
        issuer_matches: claims.iss === principal.issuer,
        subject_matches: claims.sub === principal.subject,
        nonce_matches: claims.nonce === input.nonce,
        recent_auth: isRecentAuthentication(claims.auth_time, this.recentAuthSeconds),
      });
      return null;
    }
    if (!(await this.unlocks.consumeChallenge({ state: input.state, sessionToken: session })))
      return null;
    const grant = this.unlocks.createGrantsForArchive
      ? await this.unlocks.createGrantsForArchive({
          sessionToken: session,
          archiveId: challenge.archiveId,
        })
      : await this.unlocks.createGrant({
          sessionToken: session,
          archiveId: challenge.archiveId,
          conversationId: challenge.conversationId,
        });
    this.diagnostic("oidc.unlock.accepted", {});
    return grant;
  }

  async grantedConversationIds(
    session: string | undefined,
    archiveId: string,
  ): Promise<readonly string[]> {
    if (!session || !this.unlocks?.listGrantedConversationIds) return [];
    return this.unlocks.listGrantedConversationIds({ sessionToken: session, archiveId });
  }

  async relock(session: string | undefined): Promise<void> {
    if (session && this.unlocks) await this.unlocks.revokeSession(session);
  }

  async validateUnlock(
    session: string | undefined,
    grant: string | undefined,
    archiveId: string,
    conversationId: string,
  ): Promise<ArchivePrincipal | null> {
    const principal = await this.validate(session, archiveId);
    if (!principal || !grant || !this.unlocks) return null;
    return (await this.unlocks.validateGrant({
      grantToken: grant,
      sessionToken: session!,
      archiveId,
      conversationId,
    }))
      ? principal
      : null;
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
    try {
      if (session && this.unlocks) await this.unlocks.revokeSession(session);
    } finally {
      await this.sessions.revoke(session);
    }
  }
}

export function isRecentAuthentication(authTime: unknown, maxAgeSeconds: number): boolean {
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
  const age = Date.now() - authTime * 1_000;
  return age >= 0 && age <= Math.max(1, maxAgeSeconds) * 1_000;
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
