import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

describe("web middleware", () => {
  it("returns a healthy JSON response for the health route", async () => {
    const response = middleware(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("passes non-health routes through", () => {
    const response = middleware(new Request("http://localhost/"));

    expect(response.status).toBe(200);
  });
});
