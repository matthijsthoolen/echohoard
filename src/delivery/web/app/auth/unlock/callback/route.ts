import { getWebRuntime } from "../../../../runtime";
import { createUnlockCallbackRoute } from "../../routes";

export const GET = createUnlockCallbackRoute({ getRuntime: getWebRuntime });
