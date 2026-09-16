import { getWebRuntime } from "../../../../runtime";
import { createUnlockStartRoute } from "../../routes";

export const GET = createUnlockStartRoute({ getRuntime: getWebRuntime });
