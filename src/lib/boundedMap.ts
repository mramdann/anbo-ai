export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value === undefined) return undefined;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) {
      const oldest = this.keys().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}
