import { profileNow } from "../shared/performance";

/** Share the event loop with progress, cancellation, and Penpot's own work. */
export class ImportScheduler {
  private sliceStart = profileNow();
  private units = 0;
  yieldCount = 0;
  yieldMs = 0;

  constructor(private readonly budgetMs = 4, private readonly maxUnits = 100) {}

  checkpoint(): Promise<void> | undefined {
    this.units += 1;
    const now = profileNow();
    if (this.units < this.maxUnits && now - this.sliceStart < this.budgetMs) return;
    this.units = 0;
    this.yieldCount += 1;
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      this.sliceStart = profileNow();
      this.yieldMs += this.sliceStart - now;
    });
  }
}
