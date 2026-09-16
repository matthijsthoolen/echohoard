import type { WebRuntime } from "../../runtime";
import { renderErrorDocument } from "../../error-document";

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
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    try {
      return await runtime.auth.logout(request);
    } catch {
      return unavailable();
    }
  };
}

export function createUnlockStartRoute({ getRuntime }: AuthRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    const url = new URL(request.url);
    const unlockHandle = url.searchParams.get("unlockHandle");
    if (unlockHandle) {
      try {
        return await runtime.auth.unlockStartHandle(request, unlockHandle);
      } catch {
        return denied();
      }
    }
    const archiveId = url.searchParams.get("archiveId");
    const conversationId = url.searchParams.get("conversationId");
    if (!archiveId || !conversationId) return denied();
    try {
      return await runtime.auth.unlockStart(request, archiveId, conversationId);
    } catch {
      return denied();
    }
  };
}

export function createUnlockCallbackRoute({ getRuntime }: AuthRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unavailable();
    try {
      return await runtime.auth.unlockCallback(request);
    } catch {
      return denied();
    }
  };
}

function unavailable(): Response {
  return new Response(renderErrorDocument("service-unavailable"), {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function denied(): Response {
  return new Response(renderErrorDocument("access-denied"), {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
