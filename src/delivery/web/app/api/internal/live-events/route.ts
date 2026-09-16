import { getWebRuntime } from "../../../../runtime.js";
import { createLiveEventRoute } from "./route-handler.js";

export const POST = createLiveEventRoute({
  getIntake: () => getWebRuntime()?.liveEventIntake,
});
