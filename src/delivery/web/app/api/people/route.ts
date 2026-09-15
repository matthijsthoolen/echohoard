import { getWebRuntime } from "../../../runtime";
import { createPeopleRoute } from "./route-handler";

export const GET = createPeopleRoute({ getRuntime: getWebRuntime });
