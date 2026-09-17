import { getWebRuntime } from "../../../../runtime";
import { createUnlockRelockRoute } from "../../routes";

export const POST = createUnlockRelockRoute({ getRuntime: getWebRuntime });
