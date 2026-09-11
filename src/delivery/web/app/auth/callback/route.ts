import { getWebRuntime } from "../../../runtime";
import { createCallbackRoute } from "../routes";

export const GET = createCallbackRoute({ getRuntime: getWebRuntime });
