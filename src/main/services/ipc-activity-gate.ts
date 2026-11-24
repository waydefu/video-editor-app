/** Prevent an update from racing in-flight IPC writes or new renderer work. */
export class IpcActivityGate {
  private active = 0;
  private sealed = false;

  get isSealed(): boolean {
    return this.sealed;
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.sealed) throw new Error("正在安全切換版本，暫時不能開始新作業。");
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }

  seal(): () => void {
    if (this.sealed || this.active > 0) throw new Error("仍有應用程式操作正在執行，請完成後再更新。");
    this.sealed = true;
    return () => {
      this.sealed = false;
    };
  }
}
