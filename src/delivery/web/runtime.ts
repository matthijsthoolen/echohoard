import type { ReadPorts } from "../../application/reads.js";
import type { WebAuthBoundary } from "./auth.js";

export type WebReadServices = Pick<ReadPorts, "listConversations">;

export interface WebRuntime {
  readonly auth: WebAuthBoundary;
  readonly reads: WebReadServices;
}

let activeRuntime: WebRuntime | undefined;

/**
 * The composition root supplies the authenticated services at process start.
 * Keeping this boundary explicit prevents route handlers from importing Prisma
 * and makes the delivery contract straightforward to test with fake services.
 */
export function configureWebRuntime(runtime: WebRuntime): void {
  activeRuntime = runtime;
}

export function getWebRuntime(): WebRuntime | undefined {
  return activeRuntime;
}
