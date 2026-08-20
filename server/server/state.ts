import type { ModelConfig, RequestLog } from "./types.js";

export class RuntimeState {
  private readonly loads = new Map<string, number>();
  private readonly logs: RequestLog[] = [];

  constructor(models: ModelConfig[]) {
    for (const model of models) this.loads.set(model.id, 0);
  }

  snapshotLoads(): ReadonlyMap<string, number> {
    return new Map(this.loads);
  }

  reserve(model: ModelConfig, amount: number): boolean {
    const current = this.loads.get(model.id) ?? 0;
    if (current + amount >= model.hardCapacity) return false;
    this.loads.set(model.id, current + amount);
    return true;
  }

  release(modelId: string, amount: number): void {
    const current = this.loads.get(modelId) ?? 0;
    this.loads.set(modelId, Math.max(0, current - amount));
  }

  addLog(log: RequestLog): void {
    this.logs.unshift(log);
    if (this.logs.length > 100) this.logs.length = 100;
  }

  updateLog(id: string, patch: Partial<RequestLog>): void {
    const log = this.logs.find((item) => item.id === id);
    if (log) Object.assign(log, patch);
  }

  listLogs(): RequestLog[] {
    return this.logs.map((log) => ({ ...log }));
  }
}
