import { describe, expect, it } from "vitest";
import { createAdminIdentityApprovalRoute } from "./route-handler";

describe("admin identity approval route", () => {
  it("bounds input before invoking the authenticated approval boundary", async () => {
    const seen: string[] = [];
    const route = createAdminIdentityApprovalRoute({
      getRuntime: () => ({
        auth: {
          approveIdentity: async (_request, issuer, subject) => {
            seen.push(issuer, subject);
            return Response.json({ approved: true });
          },
          pendingIdentities: async () => Response.json({ identities: [] }),
        },
      }),
    });
    const response = await route(
      new Request("http://localhost/api/admin/identities", {
        method: "POST",
        body: JSON.stringify({ issuer: "https://issuer.example.test", subject: "person-2" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(["https://issuer.example.test", "person-2"]);
  });

  it("rejects malformed or oversized identity input", async () => {
    const route = createAdminIdentityApprovalRoute({
      getRuntime: () => ({
        auth: {
          approveIdentity: async () => Response.json({ approved: true }),
          pendingIdentities: async () => Response.json({ identities: [] }),
        },
      }),
    });
    await expect(
      route(
        new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ issuer: "", subject: "person" }),
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
  });
});
