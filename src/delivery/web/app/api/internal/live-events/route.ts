import { getWebRuntime } from "../../../../runtime";
import { createLiveEventRoute } from "./route-handler";

export const POST = createLiveEventRoute({
  getIntake: () => getWebRuntime()?.liveEventIntake,
});
