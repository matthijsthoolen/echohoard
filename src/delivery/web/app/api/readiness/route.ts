import { getWebRuntime } from "../../../runtime";
import { createHealthRoute } from "../health/route-handler";

/** Readiness is private and archive-aware. It intentionally uses the same
 * bounded evidence contract as the authenticated health endpoint. */
export const GET = createHealthRoute({ getRuntime: getWebRuntime });
