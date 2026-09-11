import { getWebRuntime } from "../../../../runtime";
import { createAdminIdentityApprovalRoute, createAdminIdentityListRoute } from "./route-handler";

export const POST = createAdminIdentityApprovalRoute({ getRuntime: getWebRuntime });
export const GET = createAdminIdentityListRoute({ getRuntime: getWebRuntime });
