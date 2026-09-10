import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  MediaObservation,
  MediaPathResolverPort,
  MediaResolution,
} from "../../application/media.js";

export interface MediaPathIndexEntry {
  readonly relativePath: string;
}

export interface MediaPathResolverOptions {
  /** Maximum number of indexed filename candidates considered by fallback. */
  readonly maxFallbackCandidates?: number;
}

/**
 * Resolves adapter observations against a delivery-owned file index. The
 * index is an allowlist; no source value is ever joined to the root before it
 * has passed normalization and containment checks.
 */
export class LocalMediaPathResolver implements MediaPathResolverPort {
  private readonly index = new Map<string, string>();
  private readonly byFilename = new Map<string, string[]>();
  private readonly maxFallbackCandidates: number;

  public constructor(
    private readonly deliveryRoot: string,
    entries: readonly MediaPathIndexEntry[],
    options: MediaPathResolverOptions = {},
  ) {
    this.maxFallbackCandidates = options.maxFallbackCandidates ?? 32;
    for (const entry of entries) {
      const normalized = normalizeRelativePath(entry.relativePath);
      if (!normalized) continue;
      this.index.set(normalized, normalized);
      const filename = basename(normalized);
      const matches = this.byFilename.get(filename) ?? [];
      matches.push(normalized);
      this.byFilename.set(filename, matches);
    }
  }

  public async resolve(observation: MediaObservation): Promise<MediaResolution> {
    if (observation.relativePath !== undefined) {
      const normalized = normalizeRelativePath(observation.relativePath);
      if (!normalized) return { state: "unresolved", reason: "unsafe" };
      const indexed = this.index.get(normalized);
      if (!indexed) return { state: "unresolved", reason: "missing" };
      return this.verify(indexed);
    }

    const filename =
      observation.filename === undefined ? null : normalizeFilename(observation.filename);
    if (!filename) return { state: "unresolved", reason: "missing" };
    const candidates = this.byFilename.get(filename) ?? [];
    if (candidates.length === 0) return { state: "unresolved", reason: "missing" };
    if (candidates.length > this.maxFallbackCandidates || candidates.length !== 1)
      return { state: "unresolved", reason: "ambiguous" };
    return this.verify(candidates[0]!);
  }

  private async verify(relativePath: string): Promise<MediaResolution> {
    const path = join(this.deliveryRoot, ...relativePath.split("/"));
    try {
      const details = await lstat(path);
      if (!details.isFile() && !details.isSymbolicLink())
        return { state: "unresolved", reason: "missing" };
      const root = await realpath(this.deliveryRoot);
      const target = await realpath(path);
      const outside = relative(root, target);
      if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside))
        return { state: "unresolved", reason: "unsafe" };
      return { state: "resolved", path: target, relativePath };
    } catch {
      return { state: "unresolved", reason: "missing" };
    }
  }
}

/** Build an allowlist from regular files under a delivery root. Symlinks are
 * indexed so resolution can explicitly reject links escaping the root. */
export async function indexMediaPaths(root: string): Promise<readonly MediaPathIndexEntry[]> {
  const entries: MediaPathIndexEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relativePath);
      else if (entry.isFile() || entry.isSymbolicLink()) entries.push({ relativePath });
    }
  }
  await visit(root, "");
  return entries;
}

function normalizeFilename(value: string): string | null {
  const normalized = normalizeRelativePath(value);
  return normalized && !normalized.includes("/") ? normalized : null;
}

function normalizeRelativePath(value: string): string | null {
  if (!value || value.includes("\0")) return null;
  const candidate = value.normalize("NFC").replaceAll("\\", "/");
  if (candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate) || candidate.startsWith("//"))
    return null;
  const parts = candidate.split("/");
  if (parts.some((part) => part === "..")) return null;
  const cleaned = parts.filter((part) => part !== "").filter((part) => part !== ".");
  return cleaned.length ? cleaned.join("/") : null;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}
