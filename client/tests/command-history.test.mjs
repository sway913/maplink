import assert from 'node:assert/strict';
import test from 'node:test';
import historyModule from '../ui/command-history.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('command history persists, deduplicates and caps entries', () => {
  const storage = new MemoryStorage();
  const history = new historyModule.CommandHistory(storage, 'test', 3);
  history.record('whoami');
  history.record('uname -a');
  history.record('whoami');
  history.record('pwd');
  history.record('date');
  assert.deepEqual(history.list(), ['date', 'pwd', 'whoami']);
  assert.deepEqual(new historyModule.CommandHistory(storage, 'test', 3).list(), ['date', 'pwd', 'whoami']);
});

test('command history restores the draft while navigating', () => {
  const history = new historyModule.CommandHistory(new MemoryStorage());
  history.record('first');
  history.record('second');
  assert.equal(history.previous('draft command'), 'second');
  assert.equal(history.previous(), 'first');
  assert.equal(history.next(), 'second');
  assert.equal(history.next(), 'draft command');
  history.clear();
  assert.deepEqual(history.list(), []);
});
