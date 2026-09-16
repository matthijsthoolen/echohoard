import { createMcpRoute } from "./route-handler";
import { getWebRuntime } from "../../runtime";

export const runtime = "nodejs";

const handle = createMcpRoute({
  getRuntime: () => {
    const runtime = getWebRuntime();
    return runtime?.mcp ? { mcp: runtime.mcp } : undefined;
  },
});

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
