import { getWebRuntime } from "../../../../../runtime";
import { createAdminAccountActionRoute, createAdminAccountGetRoute } from "./route-handler";

const dependencies = { getRuntime: getWebRuntime };
export const GET = createAdminAccountGetRoute(dependencies);
export const POST = createAdminAccountActionRoute(dependencies);
