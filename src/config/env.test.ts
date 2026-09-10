import { describe, expect, it } from "vitest";
import { env, parseEnv } from "./env";

describe("environment configuration", () => {
  it("defaults to the web role", () => {
    expect(env.ECHOHOARD_ROLE).toBe("web");
    expect(env.NODE_ENV).toBe("test");
  });

  it("keeps configured OIDC settings available to the composition root", () => {
    expect(
      parseEnv({
        NODE_ENV: "production",
        ECHOHOARD_ROLE: "web",
        OIDC_ISSUER: "https://auth.example.test/application/o/echohoard/",
        OIDC_CLIENT_ID: "echohoard",
        OIDC_REDIRECT_URI: "https://echohoard.example.test/auth/callback",
        OIDC_SUBJECT: "owner-subject",
        OIDC_CLIENT_SECRET_FILE: "/run/echohoard/secrets/oidc-client-secret",
      }),
    ).toMatchObject({
      NODE_ENV: "production",
      ECHOHOARD_ROLE: "web",
      OIDC_ISSUER: "https://auth.example.test/application/o/echohoard/",
      OIDC_CLIENT_ID: "echohoard",
      OIDC_REDIRECT_URI: "https://echohoard.example.test/auth/callback",
      OIDC_SUBJECT: "owner-subject",
      OIDC_CLIENT_SECRET_FILE: "/run/echohoard/secrets/oidc-client-secret",
    });
  });

  it("does not copy unrelated process variables into the runtime config", () => {
    expect(parseEnv({ UNRELATED: "ignored" })).toEqual({
      NODE_ENV: "development",
      ECHOHOARD_ROLE: "web",
    });
  });

  it("rejects malformed OIDC URLs and empty identifiers", () => {
    expect(() => parseEnv({ OIDC_ISSUER: "not-a-url" })).toThrow();
    expect(() => parseEnv({ OIDC_CLIENT_ID: "" })).toThrow();
    expect(() => parseEnv({ OIDC_REDIRECT_URI: "not-a-url" })).toThrow();
    expect(() => parseEnv({ OIDC_SUBJECT: "" })).toThrow();
    expect(() => parseEnv({ OIDC_CLIENT_SECRET_FILE: "" })).toThrow();
  });
});
