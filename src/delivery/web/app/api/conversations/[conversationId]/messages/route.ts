import { getWebRuntime } from "../../../../../runtime";
import { createMessagesRoute } from "./route-handler";

const getMessages = createMessagesRoute({ getRuntime: getWebRuntime });

export const GET = (
  request: Request,
  context: { readonly params: Promise<{ readonly conversationId: string }> },
) => getMessages(request, context);
