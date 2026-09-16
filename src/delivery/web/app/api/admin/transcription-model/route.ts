import { getWebRuntime } from "../../../../runtime";
import {
  createTranscriptionModelGetRoute,
  createTranscriptionModelPutRoute,
} from "./route-handler";

export const GET = createTranscriptionModelGetRoute({ getRuntime: getWebRuntime });
export const PUT = createTranscriptionModelPutRoute({ getRuntime: getWebRuntime });
