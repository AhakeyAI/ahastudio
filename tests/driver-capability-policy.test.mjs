// Capability-driven policy: hook approval dialects, headless support reasons, and native resume rules.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_DRIVER_CAPABILITIES, AGENT_DRIVER_IDS } from '../dist-electron/agent-drivers/driver-capabilities.js';
import {
  headlessResumeError, headlessWorkerSupportError, headlessWorkerSupports, providerRefs,
} from '../dist-electron/orchestration/headless-workers.js';
import { buildProviderDecisionStdout, hookApprovalDialectFor } from '../dist-electron/orchestration/permission-approvals.js';

test('hook approval stdout keeps each provider dialect byte for byte', () => {
  const claudePre = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}\n';
  const claudeAsk = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"a":1}}}}\n';
  const topLevelDeny = '{"decision":"deny","reason":"no"}\n';
  const combinedDeny = '{"decision":"deny","reason":"no","hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no"}}}\n';
  assert.equal(buildProviderDecisionStdout('Claude', 'PreToolUse', 'deny', 'no'), claudePre);
  assert.equal(buildProviderDecisionStdout('claude', 'PermissionRequest', 'allow', undefined, { a: 1 }), claudeAsk);
  for (const provider of ['antigravity', 'agy', 'gemini']) {
    assert.equal(buildProviderDecisionStdout(provider, 'PermissionRequest', 'deny', 'no'), topLevelDeny, provider);
    assert.equal(buildProviderDecisionStdout(provider, 'PermissionRequest', 'allow'), '{"decision":"allow"}\n', provider);
  }
  for (const provider of ['grok', 'codex', 'opencode', 'pi', 'qwen', 'kimi']) {
    assert.equal(buildProviderDecisionStdout(provider, '', 'deny', 'no'), combinedDeny, provider);
  }
  assert.equal(hookApprovalDialectFor('unknown-cli'), 'combined');
});

test('every driver declares the orchestration capability dimensions', () => {
  for (const id of AGENT_DRIVER_IDS) {
    const caps = AGENT_DRIVER_CAPABILITIES[id];
    assert.ok(['strong', 'weak', 'none'].includes(caps.nativeThreadIds), id);
    for (const flag of ['resumeAcrossCwd', 'acceptsDeveloperContext', 'supportsSteer']) {
      assert.equal(typeof caps[flag], 'boolean', `${id}.${flag}`);
    }
  }
  assert.equal(AGENT_DRIVER_CAPABILITIES.claude.resumeAcrossCwd, false);
  assert.equal(AGENT_DRIVER_CAPABILITIES.codex.resumeAcrossCwd, true);
});

test('headless support refusals carry a code', () => {
  assert.equal(headlessWorkerSupportError('codex', 'read-only'), null);
  assert.equal(headlessWorkerSupportError('pi', 'read-only').code, 'driver_not_headless');
  assert.equal(headlessWorkerSupportError('opencode', 'workspace-write').code, 'driver_not_headless');
  assert.equal(headlessWorkerSupportError('grok', 'read-only').code, 'policy_unsupported');
  assert.equal(headlessWorkerSupportError('antigravity', 'read-only').code, 'policy_unsupported');
  assert.equal(headlessWorkerSupports('grok', 'read-only'), false);
  assert.equal(headlessWorkerSupports('claude', 'read-only'), true);
});

test('native resume is refused across worktrees for cwd-bound drivers only', () => {
  const here = process.cwd();
  const elsewhere = `${here}-other`;
  assert.equal(headlessResumeError('claude', { providerSessionId: 's1', sessionCwd: here, cwd: here }), null);
  assert.equal(headlessResumeError('claude', { providerSessionId: 's1', sessionCwd: here, cwd: elsewhere }).code, 'cwd_bound_session');
  assert.equal(headlessResumeError('codex', { providerSessionId: 't1', sessionCwd: here, cwd: elsewhere }), null);
  assert.equal(headlessResumeError('grok', { providerSessionId: ' ', sessionCwd: here, cwd: here }).code, 'no_provider_session');
  assert.equal(headlessResumeError('pi', { providerSessionId: 'f', sessionCwd: here, cwd: here }).code, 'driver_not_headless');
  if (process.platform === 'win32') {
    assert.equal(headlessResumeError('claude', { providerSessionId: 's1', sessionCwd: here.toUpperCase(), cwd: here }), null);
  }
});

test('provider refs record id strength and drop blank ids', () => {
  assert.deepEqual(providerRefs('pi', { sessionId: ' /tmp/s.jsonl ', turnId: '' }), {
    driver: 'pi', idStrength: 'weak', sessionId: '/tmp/s.jsonl',
  });
  assert.deepEqual(providerRefs('codex', { sessionId: null, requestId: 'r1' }), {
    driver: 'codex', idStrength: 'strong', sessionId: null, requestId: 'r1',
  });
});
