import { getWebRuntime } from "../../../runtime";
import { createConversationsRoute } from "./route-handler";

export const GET = createConversationsRoute({ getRuntime: getWebRuntime });
