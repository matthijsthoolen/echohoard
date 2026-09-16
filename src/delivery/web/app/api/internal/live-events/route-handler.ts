import {
  LIVE_EVENT_MAX_BYTES,
  type LiveEventIntakeService,
} from "../../../../../../application/live-event-intake.js";

export interface LiveEventRouteDependencies {
  readonly getIntake: () => LiveEventIntakeService | undefined;
}

export function createLiveEventRoute({ getIntake }: LiveEventRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const intake = getIntake();
    if (!intake) return new Response("Live event intake is unavailable.", { status: 503 });
    const contentLength = request.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > LIVE_EVENT_MAX_BYTES)
    )
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    const body = new Uint8Array(await request.arrayBuffer());
    const result = await intake.accept({
      accountKey: request.headers.get("x-echohoard-account") ?? "",
      signature: request.headers.get("x-echohoard-signature"),
      timestamp: request.headers.get("x-echohoard-timestamp"),
      body,
    });
    if (result.status === "accepted" || result.status === "duplicate") {
      return Response.json({ status: result.status, receiptId: result.receiptId }, { status: 202 });
    }
    if (result.reason === "backpressure") {
      return Response.json(
        { error: result.reason },
        { status: 429, headers: { "Retry-After": "5" } },
      );
    }
    const status = result.reason === "payload_too_large" ? 413 : 401;
    return Response.json({ error: result.reason }, { status });
  };
}
