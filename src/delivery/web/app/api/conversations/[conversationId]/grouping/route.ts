import { getWebRuntime } from "../../../../../runtime";
import { createGroupingRoute } from "./route-handler";
export const POST = (
  request: Request,
  context: { readonly params: Promise<{ readonly conversationId: string }> },
) => createGroupingRoute({ getRuntime: getWebRuntime })(request, context);
export const GET = POST;
