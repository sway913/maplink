(function attachCommandHistory(root) {
  const STORAGE_KEY = 'maplink.remoteCommandHistory.v1';
  const MAX_ENTRIES = 100;

  class CommandHistory {
    constructor(storage, key = STORAGE_KEY, limit = MAX_ENTRIES) {
      this.storage = storage;
      this.key = key;
      this.limit = limit;
      this.entries = this.load();
      this.cursor = -1;
      this.draft = '';
    }

    load() {
      try {
        const parsed = JSON.parse(this.storage.getItem(this.key) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, this.limit);
      } catch {
        return [];
      }
    }

    save() {
      this.storage.setItem(this.key, JSON.stringify(this.entries));
    }

    record(command) {
      const value = String(command || '').trim();
      if (!value) return this.list();
      this.entries = [value, ...this.entries].slice(0, this.limit);
      this.save();
      this.resetNavigation();
      return this.list();
    }

    clear() {
      this.entries = [];
      this.storage.removeItem(this.key);
      this.resetNavigation();
    }

    list() {
      return [...this.entries];
    }

    recallList() {
      return [...new Set(this.entries)];
    }

    previous(currentValue = '') {
      const entries = this.recallList();
      if (!entries.length) return String(currentValue);
      if (this.cursor === -1) this.draft = String(currentValue);
      this.cursor = Math.min(this.cursor + 1, entries.length - 1);
      return entries[this.cursor];
    }

    next() {
      if (this.cursor === -1) return this.draft;
      this.cursor -= 1;
      return this.cursor === -1 ? this.draft : this.recallList()[this.cursor];
    }

    resetNavigation() {
      this.cursor = -1;
      this.draft = '';
    }
  }

  function keyAction(event) {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return null;
    if (event.key === 'ArrowUp' && !event.shiftKey) return 'previous';
    if (event.key === 'ArrowDown' && !event.shiftKey) return 'next';
    if (event.key === 'Enter' && !event.shiftKey) return 'execute';
    return null;
  }

  const api = { CommandHistory, keyAction, STORAGE_KEY, MAX_ENTRIES };
  root.MapLinkCommandHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(globalThis));
