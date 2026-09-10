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

export interface MediaCasObject {
  readonly sha256: string;
  readonly path: string;
  readonly size: number;
  readonly duplicate: boolean;
}

/** Stores resolved source bytes in EchoHoard-owned content-addressed storage. */
export interface MediaCasStorePort {
  store(sourcePath: string, expectedSha256?: string): Promise<MediaCasObject>;
}
