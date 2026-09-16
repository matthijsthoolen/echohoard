import { describe, expect, it } from "vitest";
import {
  LiveEventIntakeService,
  signLiveEvent,
  stableReceiptId,
  type LiveEventMetrics,
  type LiveEventPayloadValidator,
} from "./live-event-intake.js";
import type { LiveEventInboxPort } from "./persistence.js";

const body = new TextEncoder().encode(
  JSON.stringify({
    Chat: "chat.synthetic",
    ID: "message-1",
    SenderJID: "sender.synthetic",
    Timestamp: "2026-01-01T00:00:00.000Z",
    FromMe: false,
    Text: "synthetic event",
  }),
);

class Metrics implements LiveEventMetrics {
  readonly values: string[] = [];
  rejected(reason: Parameters<LiveEventMetrics["rejected"]>[0]): void {
    this.values.push(`rejected:${reason}`);
  }
  accepted(kind: Parameters<LiveEventMetrics["accepted"]>[0]): void {
    this.values.push(`accepted:${kind}`);
  }
}

function service(
  inbox: LiveEventInboxPort,
  metrics = new Metrics(),
): [LiveEventIntakeService, Metrics] {
  const validator: LiveEventPayloadValidator = {
    validate: (payload, accountKey) => {
      const value = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      if (typeof value.Chat !== "string" || typeof value.ID !== "string")
        throw new Error("invalid synthetic event");
      return {
        kind: "message",
        sourceEventKey: `wacli:message:${accountKey}:${value.Chat}:${value.ID}`,
        observedAt: String(value.Timestamp),
        payload: value,
      };
    },
  };
  return [
    new LiveEventIntakeService(
      {
        resolve: async (accountKey) =>
          accountKey === "account-a"
            ? { archiveId: "archive", ownedAccountId: "account", secret: "secret" }
            : null,
      },
      inbox,
      metrics,
      validator,
      1,
      300,
      () => new Date("2026-01-01T00:00:00.000Z"),
    ),
    metrics,
  ];
}

describe("signed live event intake", () => {
  it("authenticates, validates, and stages before returning an accepted result", async () => {
    const calls: Parameters<LiveEventInboxPort["enqueue"]>[0][] = [];
    const [intake, metrics] = service({
      enqueue: async (input) => {
        calls.push(input);
        return { kind: "accepted" };
      },
    });
    const result = await intake.accept({
      accountKey: "account-a",
      timestamp: "1767225600",
      signature: signLiveEvent(body, 1767225600, "secret"),
      body,
    });
    expect(result.status).toBe("accepted");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.receiptId).toBe(
      stableReceiptId("account-a", "wacli:message:account-a:chat.synthetic:message-1"),
    );
    expect(metrics.values).toEqual(["accepted:accepted"]);
  });

  it("rejects tampering, stale delivery, unknown accounts, malformed payloads, and backpressure without writes", async () => {
    let writes = 0;
    const inbox: LiveEventInboxPort = {
      enqueue: async () => {
        writes += 1;
        return { kind: "accepted" };
      },
    };
    const [intake, metrics] = service(inbox);
    const base = {
      accountKey: "account-a",
      timestamp: "1767225600",
      signature: signLiveEvent(body, 1767225600, "secret"),
      body,
    };
    expect((await intake.accept({ ...base, body: new Uint8Array([...body, 1]) })).status).toBe(
      "rejected",
    );
    expect((await intake.accept({ ...base, timestamp: "1767220000" })).status).toBe("rejected");
    expect((await intake.accept({ ...base, accountKey: "unknown" })).status).toBe("rejected");
    expect(
      (
        await intake.accept({
          ...base,
          body: new TextEncoder().encode("{}"),
          signature: signLiveEvent(new TextEncoder().encode("{}"), 1767225600, "secret"),
        })
      ).status,
    ).toBe("rejected");
    const [fullIntake] = service({ enqueue: async () => ({ kind: "backpressure" as const }) });
    expect((await fullIntake.accept(base)).status).toBe("rejected");
    expect(writes).toBe(0);
    expect(metrics.values).toEqual([
      "rejected:invalid_signature",
      "rejected:stale_timestamp",
      "rejected:unknown_account",
      "rejected:invalid_payload",
    ]);
  });
});
