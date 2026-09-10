import { getWebRuntime } from "../../../../runtime";
import { createMediaRoute } from "./route-handler";

const getMedia = createMediaRoute({ getRuntime: getWebRuntime });

export const GET = (
  request: Request,
  context: { readonly params: Promise<{ readonly attachmentId: string }> },
) => getMedia(request, context);
