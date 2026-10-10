import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { LazyStore, type StoreOptions } from "@tauri-apps/plugin-store";

// No onChange: plugin-store delivers the changes of every store to such a
// listener, in every window that holds one (see PREFS_CHANGED_EVENT in
// settings/store). Announce a write with a Tauri event of its own instead.
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
}
