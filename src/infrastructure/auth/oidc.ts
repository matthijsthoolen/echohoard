import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  ArchivePrincipal,
  OidcClaims,
  OidcProvider,
  PrincipalDirectory,
} from "../../application/auth";

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
  ) {}
  public authorizationUrl(state: string, nonce?: string, codeChallenge?: string): string {
    const url = new URL(`${this.issuer.replace(/\/$/u, "")}/authorize`);
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
    return url.toString();
  }
  public async exchange(code: string, nonce?: string, codeVerifier?: string): Promise<OidcClaims> {
    if (!codeVerifier) return {};
    this.metadata ??= await this.discover();
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
    if (!response.ok) return {};
    const payload: unknown = await response.json();
    const idToken = (payload as { id_token?: unknown }).id_token;
    if (typeof idToken !== "string") return {};
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
      return nonce === undefined || claims.nonce === nonce ? claims : {};
    } catch {
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

export class PrismaPrincipalDirectory implements PrincipalDirectory {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly configuredIssuer: string,
    private readonly configuredSubject: string,
    private readonly configuredArchiveId: string,
  ) {}
  public async findBySubject(issuer: string, subject: string): Promise<ArchivePrincipal | null> {
    if (issuer !== this.configuredIssuer || subject !== this.configuredSubject) return null;
    const archive = await this.prisma.archive.findUnique({
      where: { id: this.configuredArchiveId },
      select: { id: true, userId: true },
    });
    if (!archive) return null;
    return { userId: archive.userId, archiveId: archive.id, issuer, subject };
  }
}
