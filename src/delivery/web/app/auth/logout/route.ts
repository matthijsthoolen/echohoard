import { getWebRuntime } from "../../../runtime";
import { createLogoutRoute } from "../routes";

export const GET = createLogoutRoute({ getRuntime: getWebRuntime });
