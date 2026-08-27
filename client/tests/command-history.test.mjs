import assert from 'node:assert/strict';
import test from 'node:test';
import historyModule from '../ui/command-history.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('command history persists the execution order and caps entries', () => {
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

test('command recall skips duplicates like the default PSReadLine history', () => {
  const history = new historyModule.CommandHistory(new MemoryStorage());
  history.record('first');
  history.record('second');
  history.record('first');
  assert.deepEqual(history.list(), ['first', 'second', 'first']);
  assert.deepEqual(history.recallList(), ['first', 'second']);
  assert.equal(history.previous('draft'), 'first');
  assert.equal(history.previous(), 'second');
  assert.equal(history.previous(), 'second');
  assert.equal(history.next(), 'first');
  assert.equal(history.next(), 'draft');
});

test('PowerShell-style key bindings execute and recall without hijacking modifiers', () => {
  const action = (key, overrides = {}) => historyModule.keyAction({
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  });
  assert.equal(action('ArrowUp'), 'previous');
  assert.equal(action('ArrowDown'), 'next');
  assert.equal(action('Enter'), 'execute');
  assert.equal(action('Enter', { shiftKey: true }), null);
  assert.equal(action('ArrowUp', { ctrlKey: true }), null);
  assert.equal(action('Enter', { isComposing: true }), null);
});
