import { getWebRuntime } from "../../../../runtime";
import { createLoginStartRoute } from "../../routes";

export const GET = createLoginStartRoute({ getRuntime: getWebRuntime });
