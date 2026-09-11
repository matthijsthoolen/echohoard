export type ArchivePrincipal = {
  userId: string;
  archiveId: string;
  subject: string;
  issuer: string;
};
export type OidcClaims = { iss?: unknown; sub?: unknown; exp?: unknown; nonce?: unknown };

export interface OidcProvider {
  authorizationUrl(state: string, nonce?: string, codeChallenge?: string): string;
  exchange(code: string, nonce?: string, codeVerifier?: string): Promise<OidcClaims>;
}

export interface PrincipalDirectory {
  findBySubject(issuer: string, subject: string): Promise<ArchivePrincipal | null>;
}

export class SessionStore {
  private readonly sessions = new Map<string, { principal: ArchivePrincipal; expiresAt: number }>();
  constructor(private readonly ttlSeconds = 3600) {}
  create(principal: ArchivePrincipal): string {
    const token = crypto.randomUUID();
    this.sessions.set(token, { principal, expiresAt: Date.now() + this.ttlSeconds * 1000 });
    return token;
  }
  get(token: string | undefined): ArchivePrincipal | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session.principal;
  }
  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

export class OidcAuth {
  constructor(
    private readonly provider: OidcProvider,
    private readonly directory: PrincipalDirectory,
    private readonly sessions: SessionStore,
  ) {}
  login(state: string, nonce?: string, codeChallenge?: string): string {
    return this.provider.authorizationUrl(state, nonce, codeChallenge);
  }
  async callback(
    code: string,
    expectedNonce?: string,
    codeVerifier?: string,
  ): Promise<string | null> {
    const claims = await this.provider.exchange(code, expectedNonce, codeVerifier);
    if (
      typeof claims.iss !== "string" ||
      typeof claims.sub !== "string" ||
      (expectedNonce !== undefined && claims.nonce !== expectedNonce) ||
      (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now())
    )
      return null;
    const principal = await this.directory.findBySubject(claims.iss, claims.sub);
    return principal ? this.sessions.create(principal) : null;
  }
  validate(session: string | undefined, archiveId?: string): ArchivePrincipal | null {
    const principal = this.sessions.get(session);
    return principal && (!archiveId || principal.archiveId === archiveId) ? principal : null;
  }
  logout(session: string | undefined): void {
    this.sessions.revoke(session);
  }
}

export const requireArchivePrincipal = (
  auth: OidcAuth,
  session: string | undefined,
  archiveId: string,
): ArchivePrincipal => {
  const principal = auth.validate(session, archiveId);
  if (!principal) throw new Error("archive access denied");
  return principal;
};
