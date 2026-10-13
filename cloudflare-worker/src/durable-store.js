export class DurableStore {
  constructor(storage, legacy) {
    this.storage = storage;
    this.legacy = legacy;
  }

  async get(key) {
    if (key.startsWith("media:")) return this.legacy.get(key);
    const item = await this.storage.get(key);
    if (item) {
      if (item.expiresAt && item.expiresAt <= Date.now()) {
        await this.storage.delete(key);
        return null;
      }
      return item.value;
    }
    // Copy existing data on first read; subsequent reads use consistent storage.
    const value = await this.legacy.get(key);
    if (value !== null) await this.put(key, value, { expirationTtl: key.startsWith("state:") ? 2592000 : 15552000 });
    return value;
  }

  async put(key, value, options = {}) {
    if (key.startsWith("media:")) return this.legacy.put(key, value, options);
    await this.storage.put(key, {
      value,
      expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null
    });
  }

  async delete(key) {
    await this.storage.delete(key);
  }

  async list({ prefix, limit = 100, cursor } = {}) {
    const items = await this.storage.list({ prefix, limit, ...(cursor ? { startAfter: cursor } : {}) });
    const keys = [];
    for (const [name, item] of items) {
      if (!item.expiresAt || item.expiresAt > Date.now()) keys.push({ name });
      else await this.storage.delete(name);
    }
    return { keys, list_complete: items.size < limit, cursor: [...items.keys()].at(-1) };
  }

  getWithMetadata(key, type) {
    return this.legacy.getWithMetadata(key, type);
  }

  async wake(time = Date.now() + 1000) {
    const current = await this.storage.getAlarm();
    if (current === null || current <= Date.now() || current > time) await this.storage.setAlarm(time);
  }
}
