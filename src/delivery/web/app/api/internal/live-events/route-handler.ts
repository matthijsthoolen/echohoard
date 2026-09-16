import {
  LIVE_EVENT_MAX_BYTES,
  type LiveEventIntakeService,
} from "../../../../../../application/live-event-intake";

export interface LiveEventRouteDependencies {
  readonly getIntake: () => LiveEventIntakeService | undefined;
  readonly readBody?: (request: Request) => Promise<Uint8Array | null>;
}

export function createLiveEventRoute({
  getIntake,
  readBody = readBoundedBody,
}: LiveEventRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const intake = getIntake();
    if (!intake) return new Response("Live event intake is unavailable.", { status: 503 });
    const contentLength = request.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > LIVE_EVENT_MAX_BYTES)
    )
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    const body = await readBody(request);
    if (body === null) return Response.json({ error: "payload_too_large" }, { status: 413 });
    const accountKey =
      request.headers.get("x-echohoard-account") ??
      new URL(request.url).searchParams.get("account");
    const result = await intake.accept({
      accountKey: accountKey ?? "",
      signature: request.headers.get("x-echohoard-signature"),
      timestamp: request.headers.get("x-echohoard-timestamp"),
      body,
    });
    if (result.status !== "rejected") {
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

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return body;
      }
      total += value.byteLength;
      if (total > LIVE_EVENT_MAX_BYTES) {
        await reader.cancel("body exceeds limit");
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}
