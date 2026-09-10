import { getWebRuntime } from "../../../runtime";
import { createSearchRoute } from "./route-handler";

export const GET = createSearchRoute({ getRuntime: getWebRuntime });
