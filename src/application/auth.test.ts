import { describe, expect, it } from "vitest";
import {
  OidcAuth,
  isRecentAuthentication,
  requireArchivePrincipal,
  type ArchivePrincipal,
  type OidcProvider,
  type SessionStore,
  type UnlockStore,
} from "./auth";

class MemorySessionStore implements SessionStore {
  private readonly values = new Map<string, ArchivePrincipal>();
  async create(principal: ArchivePrincipal): Promise<string> {
    const token = crypto.randomUUID();
    this.values.set(token, principal);
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

class MemoryUnlockStore implements UnlockStore {
  private challenge?: {
    state: string;
    sessionToken: string;
    archiveId: string;
    conversationId: string;
    consumed: boolean;
  };
  private readonly grants = new Map<
    string,
    { sessionToken: string; archiveId: string; conversationId: string }
  >();
  public locked = true;

  async createChallenge(input: Parameters<UnlockStore["createChallenge"]>[0]): Promise<boolean> {
    if (!this.locked) return false;
    this.challenge = { ...input, consumed: false };
    return true;
  }
  async findChallenge(input: Parameters<UnlockStore["findChallenge"]>[0]) {
    const challenge = this.challenge;
    return challenge &&
      challenge.state === input.state &&
      challenge.sessionToken === input.sessionToken &&
      !challenge.consumed
      ? { archiveId: challenge.archiveId, conversationId: challenge.conversationId }
      : null;
  }
  async consumeChallenge(input: Parameters<UnlockStore["consumeChallenge"]>[0]): Promise<boolean> {
    const challenge = this.challenge;
    if (
      !challenge ||
      challenge.state !== input.state ||
      challenge.sessionToken !== input.sessionToken ||
      challenge.consumed
    )
      return false;
    challenge.consumed = true;
    return true;
  }
  async createGrant(input: Parameters<UnlockStore["createGrant"]>[0]): Promise<string> {
    const token = crypto.randomUUID();
    this.grants.set(token, input);
    return token;
  }
  async validateGrant(input: Parameters<UnlockStore["validateGrant"]>[0]): Promise<boolean> {
    const grant = this.grants.get(input.grantToken);
    return Boolean(
      grant &&
        grant.sessionToken === input.sessionToken &&
        grant.archiveId === input.archiveId &&
        grant.conversationId === input.conversationId,
    );
  }
  async revokeSession(sessionToken: string): Promise<void> {
    for (const [token, grant] of this.grants) {
      if (grant.sessionToken === sessionToken) this.grants.delete(token);
    }
  }
  async cleanupExpired(): Promise<number> {
    return 0;
  }
}

const provider: OidcProvider = {
  authorizationUrl: (s) => `https://fake/authorize?state=${s}`,
  exchange: async () => ({ iss: "https://fake", sub: "admitted" }),
};
const setup = (claims = provider.exchange) => {
  const sessions: SessionStore = new MemorySessionStore();
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
  it("reports setup until an administrator exists", async () => {
    const sessions: SessionStore = new MemorySessionStore();
    const auth = new OidcAuth(
      provider,
      {
        findBySubject: async () => null,
        bootstrapState: async () => "setup",
      },
      sessions,
    );
    await expect(auth.bootstrapState()).resolves.toBe("setup");
  });

  it("maps configured subject and enforces archive scope", async () => {
    const { auth } = setup();
    const token = await auth.callback("code");
    await expect(requireArchivePrincipal(auth, token!, "a1")).resolves.toMatchObject({
      archiveId: "a1",
    });
    await expect(requireArchivePrincipal(auth, token!, "a2")).rejects.toThrow();
  });
  it("denies anonymous, wrong subject, invalid session, and logout", async () => {
    const { auth } = setup(async () => ({ iss: "https://fake", sub: "wrong" }));
    await expect(auth.validate(undefined)).resolves.toBeNull();
    expect(await auth.callback("code")).toBeNull();
    const good = setup();
    const token = await good.auth.callback("code");
    await expect(good.auth.validate("bad")).resolves.toBeNull();
    await good.auth.logout(token!);
    await expect(good.auth.validate(token!)).resolves.toBeNull();
  });

  it("fails closed when the verified-code exchange fails", async () => {
    const { auth } = setup(async () => {
      throw new Error("provider details must not escape");
    });
    expect(await auth.callback("code")).toBeNull();
  });

  it("requires recent provider authentication, consumes challenges once, and binds grants", async () => {
    expect(isRecentAuthentication(Math.floor(Date.now() / 1000), 300)).toBe(true);
    expect(isRecentAuthentication(Math.floor(Date.now() / 1000) - 301, 300)).toBe(false);
    const sessions = new MemorySessionStore();
    const unlocks = new MemoryUnlockStore();
    const stepUpProvider: OidcProvider = {
      authorizationUrl: (_state, _nonce, _challenge, options) => {
        expect(options).toEqual({ prompt: "login", maxAge: 0 });
        return "https://fake/step-up";
      },
      exchange: async (_code, nonce) => ({
        iss: "https://fake",
        sub: "admitted",
        nonce,
        auth_time: Math.floor(Date.now() / 1000),
      }),
    };
    const auth = new OidcAuth(
      stepUpProvider,
      {
        findBySubject: async () => ({
          userId: "u1",
          archiveId: "a1",
          issuer: "https://fake",
          subject: "admitted",
        }),
      },
      sessions,
      undefined,
      unlocks,
    );
    const session = await auth.callback("code");
    await expect(
      auth.beginUnlock(session, {
        state: "state",
        nonce: "nonce",
        codeChallenge: "challenge",
        archiveId: "a1",
        conversationId: "c1",
      }),
    ).resolves.toBe("https://fake/step-up");
    const grant = await auth.completeUnlock(session, {
      state: "state",
      code: "step-up-code",
      nonce: "nonce",
      codeVerifier: "verifier",
    });
    expect(grant).toBeTypeOf("string");
    await expect(
      auth.completeUnlock(session, {
        state: "state",
        code: "replayed-code",
        nonce: "nonce",
        codeVerifier: "verifier",
      }),
    ).resolves.toBeNull();
    await expect(auth.validateUnlock(session, grant, "a1", "c1")).resolves.toMatchObject({
      archiveId: "a1",
    });
    await expect(auth.validateUnlock(session, grant, "a2", "c1")).resolves.toBeNull();
    await auth.logout(session);
    await expect(auth.validateUnlock(session, grant, "a1", "c1")).resolves.toBeNull();
  });

  it("allows only an admitted administrator to approve an identity", async () => {
    let approval: Record<string, string> | undefined;
    const sessions: SessionStore = new MemorySessionStore();
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
      await auth.approveIdentity((await sessions.get(admin))!, "https://fake", "pending-subject"),
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
