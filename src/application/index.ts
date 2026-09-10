import type { DomainModule } from "../domain/index.js";
export * from "./persistence.js";
export * from "./echohoard.js";
export type ApplicationModule = { domain: DomainModule };
