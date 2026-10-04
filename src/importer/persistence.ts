import { profileNow } from "../shared/performance";

export const PERSISTENCE_BATCH_NODES = 250;
export const LARGE_BOARD_NODES = 500;

/** Give Penpot's independent persistence buffer an idle period between batches. */
export class BoardPersistence {
  private readonly listener: symbol;
  private saveGeneration = 0;
  private lastWriteGeneration = 0;
  private dirty = false;
  private units = 0;
  private saved?: () => void;
  waitCount = 0;
  waitMs = 0;

  constructor(private readonly checkCancellation: () => void, private readonly onWait: () => void) {
    this.listener = penpot.on("contentsave", () => {
      this.saveGeneration += 1;
      this.saved?.();
    });
  }

  markDirty(): void {
    this.dirty = true;
    this.lastWriteGeneration = this.saveGeneration;
  }

  checkpoint(): Promise<void> | undefined {
    this.units += 1;
    if (this.units >= PERSISTENCE_BATCH_NODES) return this.flush();
  }

  flush(): Promise<void> | undefined {
    if (!this.dirty) return;
    this.units = 0;
    this.dirty = false;
    if (this.saveGeneration > this.lastWriteGeneration) return;
    this.checkCancellation();
    this.onWait();
    this.waitCount += 1;
    const started = profileNow();
    return new Promise<void>((resolve, reject) => {
      let cancellationTimer: ReturnType<typeof setTimeout>;
      const finish = (error?: unknown) => {
        clearTimeout(deadline);
        clearTimeout(cancellationTimer);
        this.saved = undefined;
        this.waitMs += profileNow() - started;
        if (error) reject(error);
        else resolve();
      };
      const poll = () => {
        try { this.checkCancellation(); }
        catch (error) { finish(error); return; }
        cancellationTimer = setTimeout(poll, 4);
      };
      const deadline = setTimeout(() => finish(new Error("Penpot did not confirm saving this board within 30 seconds. Check the file's save status before retrying.")), 30_000);
      this.saved = () => {
        try { this.checkCancellation(); finish(); }
        catch (error) { finish(error); }
      };
      cancellationTimer = setTimeout(poll, 4);
    });
  }

  close(): void {
    penpot.off(this.listener);
  }
}
