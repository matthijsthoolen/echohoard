import { describe, expect, it, vi } from "vitest";
import {
  LIVE_EVENT_MAX_BYTES,
  signLiveEvent,
} from "../../../../../../application/live-event-intake.js";
import { createLiveEventRoute } from "./route-handler.js";

const body = new TextEncoder().encode(
  '{"Chat":"chat","ID":"message","SenderJID":"sender","Timestamp":"2026-01-01T00:00:00.000Z","FromMe":false}',
);

describe("live event HTTP route", () => {
  it("passes the signed request to durable intake", async () => {
    const accept = vi.fn().mockResolvedValue({ status: "accepted", receiptId: "receipt" });
    const route = createLiveEventRoute({ getIntake: () => ({ accept }) as never });
    const timestamp = "1767225600";
    const response = await route(
      new Request("http://web.test/api/internal/live-events", {
        method: "POST",
        headers: {
          "x-echohoard-account": "account-a",
          "x-echohoard-timestamp": timestamp,
          "x-echohoard-signature": signLiveEvent(body, Number(timestamp), "secret", "account-a"),
        },
        body,
      }),
    );
    expect(response.status).toBe(202);
    expect(accept).toHaveBeenCalledWith({
      accountKey: "account-a",
      signature: signLiveEvent(body, Number(timestamp), "secret", "account-a"),
      timestamp,
      body,
    });
  });

  it("cancels an oversized chunked request before buffering it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LIVE_EVENT_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const accept = vi.fn();
    const route = createLiveEventRoute({ getIntake: () => ({ accept }) as never });
    const response = await route(
      new Request("http://web.test/api/internal/live-events?account=account-a", {
        method: "POST",
        headers: {
          "x-echohoard-timestamp": "1767225600",
          "x-echohoard-signature": "sha256=" + "0".repeat(64),
        },
        body: stream,
        duplex: "half",
      }),
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });
});
