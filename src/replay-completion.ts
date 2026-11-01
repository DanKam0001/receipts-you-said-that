/** Tracks replay arrival/completion without assuming chunks finish in order. */
export class ReplayCompletion {
  private expected = 0;
  private completed = 0;
  private ended = false;
  private resolveDone!: () => void;
  readonly done = new Promise<void>(resolve => { this.resolveDone = resolve; });
  addChunk() { this.expected++; }
  finishChunk() { this.completed++; this.check(); }
  end() { this.ended = true; this.check(); }
  get counts() { return { expected: this.expected, completed: this.completed, ended: this.ended }; }
  private check() { if (this.ended && this.completed >= this.expected) this.resolveDone(); }
}
