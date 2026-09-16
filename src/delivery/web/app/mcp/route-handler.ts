import { MCP_MAX_REQUEST_BYTES, type PrivateMcpServer } from "../../../mcp/index";

export interface McpRouteDependencies {
  readonly getRuntime: () => McpRouteRuntime | undefined;
  readonly readBody?: (request: Request) => Promise<Uint8Array | null>;
}

export interface McpRouteRuntime {
  readonly mcp?: Pick<PrivateMcpServer, "handleRequest">;
}

/**
 * The web route is deliberately a thin package boundary. Authentication,
 * archive selection, tool registration, and audit envelopes remain owned by
 * PrivateMcpServer; this handler only bounds HTTP input before handing it over.
 */
export function createMcpRoute({ getRuntime, readBody = readBoundedBody }: McpRouteDependencies) {
  return async function handle(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime?.mcp) return unavailable();

    const body = await readBody(request);
    if (body === null) return tooLarge();
    const delegated = withBody(request, body);
    try {
      return await runtime.mcp.handleRequest(delegated);
    } catch {
      return failed();
    }
  };
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MCP_MAX_REQUEST_BYTES)
  )
    return null;
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
      if (total > MCP_MAX_REQUEST_BYTES) {
        await reader.cancel("MCP request exceeds the configured bound");
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}

function withBody(request: Request, body: Uint8Array): Request {
  const init: RequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
  };
  if (request.method !== "GET" && request.method !== "HEAD")
    init.body = new TextDecoder().decode(body);
  return new Request(request.url, init);
}

function unavailable(): Response {
  return Response.json(
    { error: "MCP endpoint unavailable" },
    { status: 503, headers: privateHeaders() },
  );
}

function tooLarge(): Response {
  return Response.json(
    { error: "MCP request too large" },
    { status: 413, headers: privateHeaders() },
  );
}

function failed(): Response {
  return Response.json({ error: "MCP request failed" }, { status: 500, headers: privateHeaders() });
}

function privateHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
