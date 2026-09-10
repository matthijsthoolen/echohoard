import type { DomainModule } from "../domain/index.js";
export * from "./persistence.js";
export type ApplicationModule = { domain: DomainModule };
