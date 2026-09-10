import { getWebRuntime } from "../../../runtime";
import { createHealthRoute } from "./route-handler";

export const GET = createHealthRoute({ getRuntime: getWebRuntime });
