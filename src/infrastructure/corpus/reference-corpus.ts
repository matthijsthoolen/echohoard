import { createHash } from "node:crypto";

export type CorpusConfig = {
  seed: number;
  messages: number;
  attachments: number;
  archives: number;
};
export type CorpusRecord = {
  kind: "message" | "attachment";
  archive: number;
  conversation: number;
  ordinal: number;
  sentAt: string;
  mediaType?: "image" | "video" | "audio" | "document";
  body?: string;
};

export const CI_CORPUS: CorpusConfig = {
  seed: 20260910,
  messages: 10_000,
  attachments: 2_000,
  archives: 2,
};
export const FULL_CORPUS: CorpusConfig = {
  seed: 20260910,
  messages: 5_000_000,
  attachments: 1_000_000,
  archives: 2,
};

function id(seed: number, n: number): number {
  let x = (seed ^ n) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
}

export function* corpusRecords(config: CorpusConfig): Generator<CorpusRecord> {
  const conversations = Math.max(2, Math.min(10_000, Math.ceil(config.messages / 250)));
  const start = Date.UTC(2014, 0, 1);
  const span = Date.UTC(2025, 0, 1) - start;
  for (let n = 0; n < config.messages; n++) {
    const archive = n % config.archives;
    const conversation = id(config.seed, n) % conversations;
    const sentAt = new Date(start + (id(config.seed + archive, n) % span)).toISOString();
    yield {
      kind: "message",
      archive,
      conversation,
      ordinal: n,
      sentAt,
      body: `synthetic-${config.seed}-${n}`,
    };
  }
  const media: CorpusRecord["mediaType"][] = ["image", "video", "audio", "document"];
  for (let n = 0; n < config.attachments; n++) {
    const archive = n % config.archives;
    yield {
      kind: "attachment",
      archive,
      conversation: id(config.seed, n) % conversations,
      ordinal: n,
      sentAt: new Date(start + (id(config.seed + 1, n) % span)).toISOString(),
      mediaType: media[id(config.seed + 2, n) % media.length],
    };
  }
}

export function corpusDistribution(config: CorpusConfig): string {
  const counts = new Map<string, number>();
  for (const record of corpusRecords(config)) {
    const key = `${record.kind}:${record.archive}:${record.conversation}:${record.mediaType ?? "none"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return createHash("sha256")
    .update(JSON.stringify([...counts].sort()))
    .digest("hex");
}
