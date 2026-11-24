/** Reject overlapping operations before their first asynchronous preflight. */
export class RenderAdmission {
  private active = false;

  get busy(): boolean {
    return this.active;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error("已有轉檔或資源作業正在進行，請等待完成。");
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }
}
