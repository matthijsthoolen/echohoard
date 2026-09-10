import { env } from "../config/env.js";

if (env.ECHOHOARD_ROLE !== "worker") throw new Error("ECHOHOARD_ROLE must be worker");
console.log("EchoHoard worker ready");
