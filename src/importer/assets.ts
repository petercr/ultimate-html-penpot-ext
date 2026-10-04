import type { AssetRef } from "../shared/contracts";

export const ASSET_UPLOAD_CONCURRENCY = 3;

function inlineMedia(url: string, fallbackMime?: string): { data: Uint8Array; mimeType: string } {
  // The plugin's fetch bridge does not expose Response.arrayBuffer(), and its
  // compartment has no constructible TextEncoder. Decode inline bytes here.
  const source = url.split("#", 1)[0].replace(/[\t\r\n]/g, "");
  const comma = source.indexOf(",");
  if (!source.startsWith("data:") || comma < 5) throw new Error("Invalid inline media URL.");
  const header = source.slice(5, comma);
  const mimeType = header.replace(/;base64$/i, "").split(";", 1)[0].trim() || fallbackMime || "text/plain";
  const payload = source.slice(comma + 1);
  if (/;base64$/i.test(header)) {
    const binary = atob(decodeURIComponent(payload));
    return { data: Uint8Array.from(binary, (character) => character.charCodeAt(0)), mimeType };
  }
  const data = new Uint8Array(payload.length * 3);
  let written = 0;
  for (let index = 0; index < payload.length; index += 1) {
    if (payload[index] === "%" && /^[\da-f]{2}$/i.test(payload.slice(index + 1, index + 3))) {
      data[written++] = parseInt(payload.slice(index + 1, index + 3), 16);
      index += 2;
      continue;
    }
    let code = payload.codePointAt(index)!;
    if (code > 0xffff) index += 1;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) data[written++] = code;
    else if (code < 0x800) {
      data[written++] = 0xc0 | (code >> 6);
      data[written++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      data[written++] = 0xe0 | (code >> 12);
      data[written++] = 0x80 | ((code >> 6) & 0x3f);
      data[written++] = 0x80 | (code & 0x3f);
    } else {
      data[written++] = 0xf0 | (code >> 18);
      data[written++] = 0x80 | ((code >> 12) & 0x3f);
      data[written++] = 0x80 | ((code >> 6) & 0x3f);
      data[written++] = 0x80 | (code & 0x3f);
    }
  }
  return { data: data.subarray(0, written), mimeType };
}

async function upload(asset: AssetRef) {
  const dataUrl = asset.dataUrl || (asset.url?.startsWith("data:") ? asset.url : undefined);
  if (dataUrl) {
    const { data, mimeType } = inlineMedia(dataUrl, asset.mimeType);
    return penpot.uploadMediaData(asset.id, data, mimeType);
  }
  if (asset.url) return penpot.uploadMediaUrl(asset.id, asset.url);
  return undefined;
}

export function mediaKey(asset: AssetRef): string {
  return asset.dataUrl || asset.url || asset.id;
}

export interface CachedMedia {
  media?: Awaited<ReturnType<typeof upload>>;
  failure?: string;
}

interface PendingUpload {
  asset: AssetRef;
  resolve: (result: CachedMedia) => void;
}

/** Only uploads run concurrently. Shape creation stays in paint order. */
export class MediaUploads {
  private readonly cache = new Map<string, Promise<CachedMedia>>();
  private readonly pending: PendingUpload[] = [];
  private readonly active = new Set<Promise<void>>();
  private stopped = false;
  uploadCount = 0;
  peakConcurrency = 0;

  constructor(private readonly isCancelled: () => boolean) {}

  prefetch(assets: Iterable<AssetRef>): void {
    for (const asset of assets) {
      if (this.stopped || this.isCancelled()) break;
      void this.get(asset);
    }
  }

  get(asset: AssetRef): Promise<CachedMedia> {
    const key = mediaKey(asset);
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.stopped || this.isCancelled()) return Promise.resolve({});
    const promise = new Promise<CachedMedia>((resolve) => this.pending.push({ asset, resolve }));
    // Store the promise before starting work, including failed uploads, so
    // repeated assets and responsive boards share an in-flight result too.
    this.cache.set(key, promise);
    this.pump();
    return promise;
  }

  stop(): void {
    this.stopped = true;
    for (const task of this.pending.splice(0)) task.resolve({});
  }

  async drain(): Promise<void> {
    // Host upload APIs cannot be aborted. Keep the import active until the
    // already-started calls settle, then allow the plugin's next import.
    await Promise.all(this.active);
  }

  private pump(): void {
    if (this.stopped || this.isCancelled()) {
      this.stop();
      return;
    }
    while (this.pending.length && this.active.size < ASSET_UPLOAD_CONCURRENCY) {
      const task = this.pending.shift()!;
      this.uploadCount += 1;
      const operation = this.run(task).then(() => {
        this.active.delete(operation);
        this.pump();
      });
      this.active.add(operation);
      this.peakConcurrency = Math.max(this.peakConcurrency, this.active.size);
    }
  }

  private async run(task: PendingUpload): Promise<void> {
    try {
      const media = await upload(task.asset);
      task.resolve(media ? { media } : { failure: "Penpot did not return uploaded media." });
    } catch (error) {
      const failure = error instanceof Error && error.message.trim() ? error.message
        : typeof error === "string" && error.trim() ? error : "Penpot returned an empty error.";
      task.resolve({ failure });
    }
  }
}
