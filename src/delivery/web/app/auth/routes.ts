import type { WebRuntime } from "../../runtime";

export interface AuthRouteDependencies {
  readonly getRuntime: () => Pick<WebRuntime, "auth"> | undefined;
}

export function createLoginStartRoute({ getRuntime }: AuthRouteDependencies) {
  return function GET(): Response {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    try {
      return runtime.auth.login();
    } catch {
      return unavailable();
    }
  };
}

export function createCallbackRoute({ getRuntime }: AuthRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    try {
      return await runtime.auth.callback(request);
    } catch {
      return unavailable();
    }
  };
}

export function createLogoutRoute({ getRuntime }: AuthRouteDependencies) {
  return function GET(request: Request): Response {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    try {
      return runtime.auth.logout(request);
    } catch {
      return unavailable();
    }
  };
}

function unavailable(): Response {
  return new Response("Authentication is temporarily unavailable.", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
