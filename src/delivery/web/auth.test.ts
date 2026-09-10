import { describe, expect, it } from "vitest";
import { OidcAuth, SessionStore, type OidcProvider } from "../../application/auth.js";
import { WebAuthBoundary, SESSION_COOKIE, STATE_COOKIE, NONCE_COOKIE } from "./auth.js";

const principal = { userId: "u1", archiveId: "a1", subject: "owner", issuer: "https://issuer" };
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
    new SessionStore(),
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
      app.web.principal(new Request("http://localhost", { headers: { cookie: session } }), "a1"),
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
    expect(app.web.principal(new Request("http://localhost"), "a1")).toBeNull();
    expect(app.web.principal(new Request("http://localhost"), "a2")).toBeNull();
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
    expect(app.web.principal(request, "a1")).not.toBeNull();
    const logout = app.web.logout(request);
    expect(logout.status).toBe(302);
    expect(app.web.principal(request, "a1")).toBeNull();
  });
});
