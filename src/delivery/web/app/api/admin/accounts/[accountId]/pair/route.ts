import { getWebRuntime } from "../../../../../../runtime";
import { createAdminPairingRoute, createAdminPairingStatusRoute } from "./route-handler";

const dependencies = { getRuntime: getWebRuntime };
export const POST = createAdminPairingRoute(dependencies);
export const GET = createAdminPairingStatusRoute(dependencies);
