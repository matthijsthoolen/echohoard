/** Source-neutral observation of a media file made by an adapter. */
export interface MediaObservation {
  readonly relativePath?: string;
  readonly filename?: string;
}

export type MediaResolution =
  | { readonly state: "resolved"; readonly path: string; readonly relativePath: string }
  | {
      readonly state: "unresolved";
      readonly reason: "missing" | "unsafe" | "ambiguous";
    };

export interface MediaPathResolverPort {
  resolve(observation: MediaObservation): Promise<MediaResolution>;
}
