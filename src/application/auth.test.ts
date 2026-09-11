import { describe, expect, it } from "vitest";
import { OidcAuth, SessionStore, requireArchivePrincipal, type OidcProvider } from "./auth";

const provider: OidcProvider = {
  authorizationUrl: (s) => `https://fake/authorize?state=${s}`,
  exchange: async () => ({ iss: "https://fake", sub: "admitted" }),
};
const setup = (claims = provider.exchange) => {
  const sessions = new SessionStore();
  const auth = new OidcAuth(
    { ...provider, exchange: claims },
    {
      findBySubject: async (issuer, subject) =>
        subject === "admitted" && issuer === "https://fake"
          ? { userId: "u1", archiveId: "a1", subject, issuer }
          : null,
    },
    sessions,
  );
  return { auth, sessions };
};
describe("OIDC archive principal", () => {
  it("maps configured subject and enforces archive scope", async () => {
    const { auth } = setup();
    const token = await auth.callback("code");
    expect(requireArchivePrincipal(auth, token!, "a1").archiveId).toBe("a1");
    expect(() => requireArchivePrincipal(auth, token!, "a2")).toThrow();
  });
  it("denies anonymous, wrong subject, invalid session, and logout", async () => {
    const { auth } = setup(async () => ({ iss: "https://fake", sub: "wrong" }));
    expect(auth.validate(undefined)).toBeNull();
    expect(await auth.callback("code")).toBeNull();
    const good = setup();
    const token = await good.auth.callback("code");
    expect(good.auth.validate("bad")).toBeNull();
    good.auth.logout(token!);
    expect(good.auth.validate(token!)).toBeNull();
  });

  it("fails closed when the verified-code exchange fails", async () => {
    const { auth } = setup(async () => {
      throw new Error("provider details must not escape");
    });
    expect(await auth.callback("code")).toBeNull();
  });

  it("allows only an admitted administrator to approve an identity", async () => {
    let approval: Record<string, string> | undefined;
    const sessions = new SessionStore();
    const auth = new OidcAuth(
      provider,
      {
        findBySubject: async () => ({
          userId: "u1",
          archiveId: "a1",
          issuer: "https://fake",
          subject: "admitted",
          role: "admin",
        }),
        approveIdentity: async (input) => {
          approval = input;
          return true;
        },
      },
      sessions,
    );
    const admin = (await auth.callback("code"))!;
    expect(
      await auth.approveIdentity(sessions.get(admin)!, "https://fake", "pending-subject"),
    ).toBe(true);
    expect(approval).toMatchObject({
      archiveId: "a1",
      approverIssuer: "https://fake",
      approverSubject: "admitted",
      issuer: "https://fake",
      subject: "pending-subject",
    });
    expect(
      await auth.approveIdentity(
        {
          userId: "u1",
          archiveId: "a1",
          issuer: "https://fake",
          subject: "member",
          role: "member",
        },
        "https://fake",
        "other",
      ),
    ).toBe(false);
  });
});
