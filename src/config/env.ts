import { z } from "zod";

const schema = z.object({ NODE_ENV: z.enum(["development", "test", "production"]).default("development"), ECHOHOARD_ROLE: z.enum(["web", "worker"]).default("web") });
export const env = schema.parse({ NODE_ENV: process.env.NODE_ENV, ECHOHOARD_ROLE: process.env.ECHOHOARD_ROLE });
