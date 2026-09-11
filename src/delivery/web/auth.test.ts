import { describe, expect, it } from "vitest";
import {
  OidcAuth,
  type ArchivePrincipal,
  type OidcProvider,
  type SessionStore,
} from "../../application/auth.js";
import { WebAuthBoundary, SESSION_COOKIE, STATE_COOKIE, NONCE_COOKIE } from "./auth.js";

const principal = { userId: "u1", archiveId: "a1", subject: "owner", issuer: "https://issuer" };
class MemorySessionStore implements SessionStore {
  private readonly values = new Map<string, ArchivePrincipal>();
  async create(value: ArchivePrincipal): Promise<string> {
    const token = crypto.randomUUID();
    this.values.set(token, value);
    return token;
  }
  async get(token: string | undefined): Promise<ArchivePrincipal | null> {
    return token ? (this.values.get(token) ?? null) : null;
  }
  async revoke(token: string | undefined): Promise<void> {
    if (token) this.values.delete(token);
  }
  async cleanupExpired(): Promise<number> {
    return 0;
  }
}
function setup(claims?: Record<string, unknown>) {
  let seenState = "";
  let seenNonce = "";
  const provider: OidcProvider = {
    authorizationUrl: (state, nonce) => {
      seenState = state;
      seenNonce = nonce ?? "";
      return `https://issuer/authorize?state=${state}`;
    },
    exchange: async () =>
      claims ?? { iss: principal.issuer, sub: principal.subject, nonce: seenNonce },
  };
  const auth = new OidcAuth(
    provider,
    {
      findBySubject: async (issuer, subject) =>
        issuer === principal.issuer && subject === principal.subject ? principal : null,
    },
    new MemorySessionStore(),
  );
  return {
    web: new WebAuthBoundary(auth, "/"),
    get state() {
      return seenState;
    },
  };
}
const cookie = (response: Response, name: string) =>
  response.headers
    .get("set-cookie")!
    .split(", ")
    .find((entry) => entry.startsWith(`${name}=`))!
    .split(";")[0];

describe("OIDC web boundary", () => {
  it("performs state/nonce protected login and maps the archive principal", async () => {
    const app = setup();
    const login = app.web.login();
    const state = cookie(login, STATE_COOKIE);
    const nonce = cookie(login, NONCE_COOKIE);
    const callback = await app.web.callback(
      new Request(`http://localhost/auth/callback?code=c&state=${app.state}`, {
        headers: { cookie: `${state}; ${nonce}` },
      }),
    );
    expect(callback.status).toBe(302);
    const session = cookie(callback, SESSION_COOKIE);
    expect(
      await app.web.principal(
        new Request("http://localhost", { headers: { cookie: session } }),
        "a1",
      ),
    ).toEqual(principal);
  });
  it("denies state, nonce, unknown subjects and cross-archive access", async () => {
    const app = setup({ iss: principal.issuer, sub: principal.subject, nonce: "wrong" });
    const login = app.web.login();
    const state = cookie(login, STATE_COOKIE);
    const nonce = cookie(login, NONCE_COOKIE);
    const badState = await app.web.callback(
      new Request("http://localhost/auth/callback?code=c&state=bad", {
        headers: { cookie: `${state}; ${nonce}` },
      }),
    );
    expect(badState.status).toBe(400);
    const badNonce = await app.web.callback(
      new Request(`http://localhost/auth/callback?code=c&state=${app.state}`, {
        headers: { cookie: `${state}; ${nonce}` },
      }),
    );
    expect(badNonce.status).toBe(403);
    await expect(app.web.principal(new Request("http://localhost"), "a1")).resolves.toBeNull();
    await expect(app.web.principal(new Request("http://localhost"), "a2")).resolves.toBeNull();
  });
  it("expires and logs out sessions", async () => {
    const app = setup();
    const login = app.web.login();
    const state = cookie(login, STATE_COOKIE);
    const nonce = cookie(login, NONCE_COOKIE);
    const callback = await app.web.callback(
      new Request(`http://localhost/auth/callback?code=c&state=${app.state}`, {
        headers: { cookie: `${state}; ${nonce}` },
      }),
    );
    const session = cookie(callback, SESSION_COOKIE);
    const request = new Request("http://localhost", { headers: { cookie: session } });
    await expect(app.web.principal(request, "a1")).resolves.not.toBeNull();
    const logout = await app.web.logout(request);
    expect(logout.status).toBe(302);
    await expect(app.web.principal(request, "a1")).resolves.toBeNull();
  });
});
