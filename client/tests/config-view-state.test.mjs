import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveConfigView, canStartOnboarding } from '../ui/config-view-state.mjs';

test('加载、首次使用、已有旧配置和运行态各有明确页面状态', () => {
  assert.equal(deriveConfigView({ profileLoaded: false, runtimeLoaded: false }).mode, 'loading');
  assert.equal(deriveConfigView({ profileLoaded: true, profile: null, runtimeLoaded: true, runtime: { installed: true, running: false } }).mode, 'onboarding');
  assert.equal(deriveConfigView({ profileLoaded: true, profile: { token: 'legacy-token', deviceCredential: '' }, runtimeLoaded: true, runtime: { installed: true, running: false } }).phase, 'stopped');
  assert.equal(deriveConfigView({ profileLoaded: true, profile: { token: 'paired-token', deviceCredential: 'credential' }, runtimeLoaded: true, runtime: { installed: true, running: true } }).phase, 'running');
});

test('状态失败、程序缺失与映射确认独立于配对结果', () => {
  assert.equal(deriveConfigView({ profileLoaded: true, profile: { token: 'x' }, runtimeLoaded: true, runtimeError: 'offline' }).phase, 'read-error');
  assert.equal(deriveConfigView({ profileLoaded: true, profileError: 'invalid TOML', runtimeLoaded: true, runtime: { installed: true, running: false } }).mode, 'error');
  assert.equal(deriveConfigView({ profileLoaded: true, profile: { token: 'x' }, runtimeLoaded: true, runtime: { installed: false, running: false } }).phase, 'missing-binary');
  assert.equal(canStartOnboarding({ credentialsReady: true, mappingConfirmed: false, proxyCount: 1 }), false);
  assert.equal(canStartOnboarding({ credentialsReady: true, mappingConfirmed: true, proxyCount: 0 }), false);
  assert.equal(canStartOnboarding({ credentialsReady: true, mappingConfirmed: true, proxyCount: 1, mappingValid: false }), false);
  assert.equal(canStartOnboarding({ credentialsReady: true, mappingConfirmed: true, proxyCount: 1 }), true);
});
