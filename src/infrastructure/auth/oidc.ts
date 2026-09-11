import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import type {
  ArchivePrincipal,
  OidcClaims,
  OidcProvider,
  PrincipalDirectory,
} from "../../application/auth.js";

export async function readSecretFile(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error("OIDC client secret file is empty");
  return value;
}

export class HttpOidcProvider implements OidcProvider {
  public constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  public authorizationUrl(state: string, nonce?: string): string {
    const url = new URL(`${this.issuer.replace(/\/$/u, "")}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    if (nonce) url.searchParams.set("nonce", nonce);
    return url.toString();
  }
  public async exchange(code: string, nonce?: string): Promise<OidcClaims> {
    const response = await this.fetcher(`${this.issuer.replace(/\/$/u, "")}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }),
    });
    if (!response.ok) return {};
    const payload: unknown = await response.json();
    const accessToken = (payload as { access_token?: unknown }).access_token;
    if (typeof accessToken !== "string") return {};
    const idToken = (payload as { id_token?: unknown }).id_token;
    let tokenNonce: unknown;
    if (typeof idToken === "string") {
      try {
        const parts = idToken.split(".");
        tokenNonce =
          parts.length === 3
            ? (
                JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
                  nonce?: unknown;
                }
              ).nonce
            : undefined;
      } catch {
        tokenNonce = undefined;
      }
    }
    const userinfo = await this.fetcher(`${this.issuer.replace(/\/$/u, "")}/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!userinfo.ok) return {};
    const claims = (await userinfo.json()) as OidcClaims;
    return nonce === undefined || tokenNonce === nonce ? { ...claims, nonce: tokenNonce } : {};
  }
}

export class PrismaPrincipalDirectory implements PrincipalDirectory {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly configuredIssuer: string,
    private readonly configuredSubject: string,
  ) {}
  public async findBySubject(issuer: string, subject: string): Promise<ArchivePrincipal | null> {
    if (issuer !== this.configuredIssuer || subject !== this.configuredSubject) return null;
    const archives = await this.prisma.archive.findMany({
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
    });
    if (archives.length !== 1) return null;
    return { userId: archives[0].userId, archiveId: archives[0].id, issuer, subject };
  }
}
