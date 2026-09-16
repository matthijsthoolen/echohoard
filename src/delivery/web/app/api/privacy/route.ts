import { getWebRuntime } from "../../../runtime";
import { createPrivacyRoute } from "./route-handler";

export const GET = createPrivacyRoute({ getRuntime: getWebRuntime });
export const PATCH = GET;
