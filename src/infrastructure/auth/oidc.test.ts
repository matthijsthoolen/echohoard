import { mkdtemp, readFile as readFileFromDisk, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpOidcProvider, readSecretFile } from "./oidc.js";

const issuer = "https://issuer.example.test/application/o/echohoard/";
const clientId = "echohoard-test-client";
const clientSecret = "synthetic-client-secret";
const redirectUri = "https://echohoard.example.test/auth/callback";
const tokenEndpoint = "https://issuer.example.test/application/o/echohoard/token";
const jwksUri = "https://issuer.example.test/application/o/echohoard/jwks";
const subject = "synthetic-subject";
const nonce = "synthetic-nonce";
const codeVerifier = "synthetic-code-verifier";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type TestKeyMaterial = {
  privateKey: CryptoKey;
  jwk: JsonWebKey & { alg: string; kid: string; use: string };
};

let signingKeys: TestKeyMaterial;
let alternatePrivateKey: CryptoKey;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256");
  const alternate = await generateKeyPair("RS256");
  signingKeys = {
    privateKey: primary.privateKey as CryptoKey,
    jwk: {
      ...(await exportJWK(primary.publicKey)),
      alg: "RS256",
      kid: "synthetic-key",
      use: "sig",
    },
  };
  alternatePrivateKey = alternate.privateKey as CryptoKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function signedToken(
  options: {
    key?: CryptoKey;
    kid?: string;
    tokenIssuer?: string;
    audience?: string;
    expiration?: number;
    tokenNonce?: string;
  } = {},
): Promise<string> {
  return new SignJWT({ nonce: options.tokenNonce ?? nonce })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "synthetic-key", typ: "JWT" })
    .setIssuer(options.tokenIssuer ?? issuer)
    .setAudience(options.audience ?? clientId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? Math.floor(Date.now() / 1000) + 300)
    .sign(options.key ?? signingKeys.privateKey);
}

function mockEndpoints(
  options: {
    discoveryText?: string;
    tokenText?: string;
    tokenStatus?: number;
    jwks?: unknown;
  } = {},
): ReturnType<typeof vi.fn<Fetcher>> {
  const fetcher = vi.fn<Fetcher>(async (input, init) => {
    const url = String(input);
    if (url === `${issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`) {
      return new Response(
        options.discoveryText ??
          JSON.stringify({ token_endpoint: tokenEndpoint, jwks_uri: jwksUri }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === tokenEndpoint) {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
      return new Response(options.tokenText ?? JSON.stringify({ id_token: "" }), {
        status: options.tokenStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === jwksUri) {
      return jsonResponse(options.jwks ?? { keys: [signingKeys.jwk] });
    }
    throw new Error(`unexpected test endpoint: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function provider(fetcher: Fetcher): HttpOidcProvider {
  return new HttpOidcProvider(issuer, clientId, clientSecret, redirectUri, fetcher);
}

describe("HttpOidcProvider", () => {
  it("verifies a valid signed ID token through mocked discovery, token, and JWK endpoints", async () => {
    const idToken = await signedToken();
    const fetcher = mockEndpoints({ tokenText: JSON.stringify({ id_token: idToken }) });

    await expect(
      provider(fetcher).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toMatchObject({
      iss: issuer,
      sub: subject,
      nonce,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const tokenRequest = fetcher.mock.calls[1]?.[1];
    const body = new URLSearchParams(String(tokenRequest?.body));
    expect(body.get("code")).toBe("synthetic-code");
    expect(body.get("client_id")).toBe(clientId);
    expect(body.get("client_secret")).toBe(clientSecret);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("code_verifier")).toBe(codeVerifier);
  });

  it("rejects an ID token signed by a different key", async () => {
    const idToken = await signedToken({ key: alternatePrivateKey });
    const fetcher = mockEndpoints({ tokenText: JSON.stringify({ id_token: idToken }) });

    await expect(
      provider(fetcher).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toEqual({});
  });

  it("rejects an ID token whose signing key is not published", async () => {
    const idToken = await signedToken({ kid: "unknown-synthetic-key" });
    const fetcher = mockEndpoints({ tokenText: JSON.stringify({ id_token: idToken }) });

    await expect(
      provider(fetcher).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toEqual({});
  });

  it.each([
    ["issuer", { tokenIssuer: "https://wrong-issuer.example.test/" }],
    ["audience", { audience: "wrong-synthetic-client" }],
  ])("rejects an ID token with the wrong %s", async (_label, claims) => {
    const idToken = await signedToken(claims);
    const fetcher = mockEndpoints({ tokenText: JSON.stringify({ id_token: idToken }) });

    await expect(
      provider(fetcher).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toEqual({});
  });

  it("rejects an expired ID token", async () => {
    const idToken = await signedToken({ expiration: Math.floor(Date.now() / 1000) - 60 });
    const fetcher = mockEndpoints({ tokenText: JSON.stringify({ id_token: idToken }) });

    await expect(
      provider(fetcher).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toEqual({});
  });

  it("rejects a token when its nonce does not match the login nonce", async () => {
    const idToken = await signedToken({ tokenNonce: "different-synthetic-nonce" });
    const fetcher = mockEndpoints({ tokenText: JSON.stringify({ id_token: idToken }) });

    await expect(
      provider(fetcher).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toEqual({});
  });

  it("fails closed for malformed discovery metadata and malformed token JSON", async () => {
    const incompleteDiscovery = mockEndpoints({
      discoveryText: JSON.stringify({ jwks_uri: jwksUri }),
    });
    await expect(
      provider(incompleteDiscovery).exchange("synthetic-code", nonce, codeVerifier),
    ).rejects.toThrow("OIDC metadata incomplete");

    const malformedToken = mockEndpoints({ tokenText: "{not-json" });
    await expect(
      provider(malformedToken).exchange("synthetic-code", nonce, codeVerifier),
    ).rejects.toThrow();
  });

  it("returns no claims for non-OK or structurally invalid token responses", async () => {
    const denied = mockEndpoints({
      tokenStatus: 400,
      tokenText: JSON.stringify({ error: "invalid_grant" }),
    });
    await expect(provider(denied).exchange("synthetic-code", nonce, codeVerifier)).resolves.toEqual(
      {},
    );

    const missingToken = mockEndpoints({
      tokenText: JSON.stringify({ access_token: "synthetic-access" }),
    });
    await expect(
      provider(missingToken).exchange("synthetic-code", nonce, codeVerifier),
    ).resolves.toEqual({});
  });

  it("constructs an authorization URL with nonce and S256 PKCE parameters", () => {
    const url = new URL(
      provider(mockEndpoints()).authorizationUrl("synthetic-state", nonce, "synthetic-challenge"),
    );

    expect(url.pathname).toBe("/application/o/authorize/");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("synthetic-state");
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(url.searchParams.get("code_challenge")).toBe("synthetic-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("does not contact discovery when no verifier is supplied", async () => {
    const fetcher = mockEndpoints();

    await expect(provider(fetcher).exchange("synthetic-code", nonce)).resolves.toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("readSecretFile", () => {
  it("trims a configured file and rejects an empty one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echohoard-oidc-test-"));
    const path = join(directory, "client-secret");
    try {
      await writeFile(path, " synthetic-client-secret \n", "utf8");
      await expect(readSecretFile(path)).resolves.toBe("synthetic-client-secret");
      await expect(readFileFromDisk(path, "utf8")).resolves.toContain("synthetic-client-secret");

      await writeFile(path, "\n", "utf8");
      await expect(readSecretFile(path)).rejects.toThrow("OIDC client secret file is empty");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
