import { readFile } from "node:fs/promises";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  ArchivePrincipal,
  AuthBootstrapState,
  OidcAuthorizationOptions,
  OidcClaims,
  OidcProvider,
  PendingIdentity,
  PrincipalDirectory,
} from "../../application/auth";
import { noopAuthDiagnostic, type AuthDiagnostic } from "../../application/auth-diagnostics";

export async function readSecretFile(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error("OIDC client secret file is empty");
  return value;
}

export class HttpOidcProvider implements OidcProvider {
  private metadata?: { token_endpoint: string; jwks_uri: string };
  public constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly diagnostic: AuthDiagnostic = noopAuthDiagnostic,
  ) {}
  public authorizationUrl(
    state: string,
    nonce?: string,
    codeChallenge?: string,
    options?: OidcAuthorizationOptions,
  ): string {
    // Authentik keeps the issuer provider-specific but exposes one global
    // authorization endpoint. The provider slug belongs in discovery/JWKS,
    // not in the authorization URL.
    const url = new URL("/application/o/authorize/", new URL(this.issuer).origin);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    if (nonce) url.searchParams.set("nonce", nonce);
    if (codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    if (options?.prompt) url.searchParams.set("prompt", options.prompt);
    if (options?.maxAge !== undefined) url.searchParams.set("max_age", String(options.maxAge));
    return url.toString();
  }
  public async exchange(code: string, nonce?: string, codeVerifier?: string): Promise<OidcClaims> {
    if (!codeVerifier) {
      this.diagnostic("oidc.exchange.rejected", { reason: "missing-code-verifier" });
      return {};
    }
    try {
      this.metadata ??= await this.discover();
    } catch (error) {
      this.diagnostic("oidc.exchange.failed", { reason: "discovery-failed" });
      throw error;
    }
    const response = await this.fetcher(this.metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    if (!response.ok) {
      this.diagnostic("oidc.exchange.failed", {
        reason: "token-endpoint-rejected",
        http_status: response.status,
      });
      return {};
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.diagnostic("oidc.exchange.failed", { reason: "token-response-invalid-json" });
      throw new Error("OIDC token response was not valid JSON");
    }
    const idToken = (payload as { id_token?: unknown }).id_token;
    if (typeof idToken !== "string" || !idToken) {
      this.diagnostic("oidc.exchange.failed", { reason: "token-response-missing-id-token" });
      return {};
    }
    try {
      const verified = await jwtVerify(
        idToken,
        createRemoteJWKSet(new URL(this.metadata.jwks_uri)),
        {
          issuer: this.issuer,
          audience: this.clientId,
        },
      );
      const claims = verified.payload as OidcClaims;
      if (nonce !== undefined && claims.nonce !== nonce) {
        this.diagnostic("oidc.exchange.failed", { reason: "nonce-mismatch" });
        return {};
      }
      this.diagnostic("oidc.exchange.accepted", { issuer_present: typeof claims.iss === "string" });
      return claims;
    } catch (error) {
      const code = errorCode(error);
      this.diagnostic("oidc.exchange.failed", {
        reason: "id-token-verification-failed",
        ...(code ? { jose_error_code: code } : {}),
      });
      return {};
    }
  }
  private async discover(): Promise<{ token_endpoint: string; jwks_uri: string }> {
    const response = await this.fetcher(
      `${this.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`,
    );
    if (!response.ok) throw new Error("OIDC discovery failed");
    const metadata = (await response.json()) as Record<string, unknown>;
    if (typeof metadata.token_endpoint !== "string" || typeof metadata.jwks_uri !== "string")
      throw new Error("OIDC metadata incomplete");
    return { token_endpoint: metadata.token_endpoint, jwks_uri: metadata.jwks_uri };
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : undefined;
}

export class PrismaPrincipalDirectory implements PrincipalDirectory {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly configuredIssuer: string,
    private readonly configuredArchiveId?: string,
  ) {}
  public async bootstrapState(): Promise<AuthBootstrapState> {
    const admin = await this.prisma.archiveIdentity.findFirst({
      where: { role: "admin" },
      select: { id: true },
    });
    return admin ? "ready" : "setup";
  }
  public async findBySubject(issuer: string, subject: string): Promise<ArchivePrincipal | null> {
    if (issuer !== this.configuredIssuer || !subject) return null;
    return this.prisma.$transaction(async (tx) => {
      await this.lockAdmission(tx);
      const archive = await this.findArchive(tx, issuer, subject);
      if (!archive) {
        const user = await tx.user.create({ data: {}, select: { id: true } });
        return tx.archive
          .create({
            data: {
              userId: user.id,
              name: "EchoHoard",
              admittedIdentities: { create: { issuer, subject, role: "admin" } },
            },
            select: { id: true, userId: true },
          })
          .then((created) => principal(created, issuer, subject, "admin"));
      }
      const existing = await tx.archiveIdentity.findUnique({
        where: {
          archiveId_issuer_subject: {
            archiveId: archive.id,
            issuer,
            subject,
          },
        },
        select: { role: true },
      });
      if (existing) {
        return existing.role === "admin" || existing.role === "member"
          ? principal(archive, issuer, subject, existing.role)
          : null;
      }
      const admin = await tx.archiveIdentity.findFirst({
        where: { archiveId: archive.id, role: "admin" },
        select: { id: true },
      });
      const role = admin ? "pending" : "admin";
      await tx.archiveIdentity.create({
        data: { archiveId: archive.id, issuer, subject, role },
      });
      return role === "admin" ? principal(archive, issuer, subject, role) : null;
    });
  }

  public async approveIdentity(input: {
    archiveId: string;
    approverIssuer: string;
    approverSubject: string;
    issuer: string;
    subject: string;
  }): Promise<boolean> {
    if (
      (this.configuredArchiveId !== undefined && input.archiveId !== this.configuredArchiveId) ||
      input.approverIssuer !== this.configuredIssuer ||
      input.issuer !== this.configuredIssuer ||
      !input.approverSubject ||
      !input.subject
    )
      return false;
    return this.prisma.$transaction(async (tx) => {
      await this.lockAdmission(tx);
      const approver = await tx.archiveIdentity.findUnique({
        where: {
          archiveId_issuer_subject: {
            archiveId: input.archiveId,
            issuer: input.approverIssuer,
            subject: input.approverSubject,
          },
        },
        select: { role: true },
      });
      if (approver?.role !== "admin") return false;
      const target = await tx.archiveIdentity.updateMany({
        where: {
          archiveId: input.archiveId,
          issuer: input.issuer,
          subject: input.subject,
          role: "pending",
        },
        data: { role: "member", approvedAt: new Date() },
      });
      return target.count === 1;
    });
  }

  public async listPendingIdentities(input: {
    archiveId: string;
    approverIssuer: string;
    approverSubject: string;
  }): Promise<readonly PendingIdentity[]> {
    if (
      (this.configuredArchiveId !== undefined && input.archiveId !== this.configuredArchiveId) ||
      input.approverIssuer !== this.configuredIssuer ||
      !input.approverSubject
    )
      return [];
    const approver = await this.prisma.archiveIdentity.findUnique({
      where: {
        archiveId_issuer_subject: {
          archiveId: input.archiveId,
          issuer: input.approverIssuer,
          subject: input.approverSubject,
        },
      },
      select: { role: true },
    });
    if (approver?.role !== "admin") return [];
    const pending = await this.prisma.archiveIdentity.findMany({
      where: { archiveId: input.archiveId, role: "pending" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { issuer: true, subject: true, createdAt: true },
    });
    return pending.map((identity) => ({
      issuer: identity.issuer,
      subject: identity.subject,
      createdAt: identity.createdAt.toISOString(),
    }));
  }

  private async lockAdmission(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.configuredArchiveId ?? `${this.configuredIssuer}:bootstrap`}, 0))`,
    );
  }

  private async findArchive(
    tx: Prisma.TransactionClient,
    issuer: string,
    subject: string,
  ): Promise<{ readonly id: string; readonly userId: string } | null> {
    if (this.configuredArchiveId !== undefined) {
      return tx.archive.findUnique({
        where: { id: this.configuredArchiveId },
        select: { id: true, userId: true },
      });
    }
    const existingIdentity = await tx.archiveIdentity.findFirst({
      where: { issuer, subject },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { archive: { select: { id: true, userId: true } } },
    });
    if (existingIdentity) return existingIdentity.archive;
    const bootstrapArchive = await tx.archiveIdentity.findFirst({
      where: { issuer, role: "admin" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { archive: { select: { id: true, userId: true } } },
    });
    if (bootstrapArchive) return bootstrapArchive.archive;
    // Without an explicitly configured archive, a new subject must bootstrap
    // its own archive. Never attach it to an unrelated archive merely because
    // that archive happens to be the oldest one in the database.
    return null;
  }
}

function principal(
  archive: { readonly id: string; readonly userId: string },
  issuer: string,
  subject: string,
  role: "admin" | "member",
): ArchivePrincipal {
  return { userId: archive.userId, archiveId: archive.id, issuer, subject, role };
}
