import type { UnlistenFn } from "@tauri-apps/api/event";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { LazyStore, type StoreOptions } from "@tauri-apps/plugin-store";

export class LocalLazyStore {
  private storePromise: Promise<LazyStore> | null = null;

  constructor(
    private readonly filename: string,
    private readonly options?: StoreOptions,
  ) {}

  private store(): Promise<LazyStore> {
    this.storePromise ??= appLocalDataDir()
      .then((root) => join(root, this.filename))
      .then((path) => new LazyStore(path, this.options));
    return this.storePromise;
  }

  async set(key: string, value: unknown): Promise<void> {
    return (await this.store()).set(key, value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.store()).get<T>(key);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.store()).delete(key);
  }

  async entries<T = unknown>(): Promise<Array<[string, T]>> {
    return (await this.store()).entries<T>();
  }

  async save(): Promise<void> {
    return (await this.store()).save();
  }

  async onChange<T>(
    callback: (key: string, value: T | undefined) => void,
  ): Promise<UnlistenFn> {
    return (await this.store()).onChange(callback);
  }
}
