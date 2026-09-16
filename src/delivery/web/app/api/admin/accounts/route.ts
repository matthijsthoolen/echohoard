import { getWebRuntime } from "../../../../runtime";
import { createAdminAccountsRoute } from "./route-handler";

export const GET = createAdminAccountsRoute({ getRuntime: getWebRuntime });
