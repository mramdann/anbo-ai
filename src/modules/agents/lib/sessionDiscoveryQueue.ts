export class AgentSessionDiscoveryQueue {
  private readonly requested = new Set<number>();
  private readonly running = new Map<number, string>();

  request(leafId: number) {
    this.requested.add(leafId);
  }

  cancel(leafId: number) {
    this.requested.delete(leafId);
  }

  retain(leafIds: ReadonlySet<number>) {
    for (const leafId of this.requested) {
      if (!leafIds.has(leafId)) this.requested.delete(leafId);
    }
  }

  begin(leafId: number, agent: string): boolean {
    if (!this.requested.has(leafId) || this.running.has(leafId)) return false;
    // Only exact-process discovery can safely bypass the claimed-ID queue.
    if (
      agent !== "antigravity" &&
      [...this.running.values()].some((value) => value !== "antigravity")
    ) {
      return false;
    }
    this.requested.delete(leafId);
    this.running.set(leafId, agent);
    return true;
  }

  finish(leafId: number) {
    this.running.delete(leafId);
  }
}
