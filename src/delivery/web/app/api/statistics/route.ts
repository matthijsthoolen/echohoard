import { getWebRuntime } from "../../../runtime";
import { createStatisticsRoute } from "./route-handler";

export const GET = createStatisticsRoute({ getRuntime: getWebRuntime });
