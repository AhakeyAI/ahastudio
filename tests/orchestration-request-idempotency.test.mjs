// Idempotent orchestration writes: one execution per (action, caller, requestId).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { RequestReceipts, requestPayloadHash } from '../dist-electron/orchestration/request-idempotency.js';

const require = createRequire(import.meta.url);
const { withRequestId } = require('../electron/orchestration/aha-orchestration-cli.cjs');

function fakeService({ fail = false } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    calls,
    release: () => release(),
    service: {
      isAuthenticatedCallerActive: () => true,
      // The router awaits durability after every write; holding it open keeps the first call in flight.
      waitForPendingWrites: () => gate,
      formatActionReceiptText: () => 'receipt',
      approve: (input, caller) => {
        calls.push({ input, caller });
        if (fail) throw new Error('boom');
        return { approved: input.id, n: calls.length };
      },
    },
  };
}

const ctx = (callerPaneId = 'pane-1') => ({ signal: new AbortController().signal, callerPaneId });

test('a retried write with the same requestId runs once and replays the first result', async () => {
  const fake = fakeService();
  const payload = { id: 'appr-1', requestId: 'req-00000001' };
  const first = dispatchOrchestrationHttpAction(fake.service, 'approve', payload, ctx());
  const concurrent = dispatchOrchestrationHttpAction(fake.service, 'approve', { ...payload, receiptText: true }, ctx());
  fake.release();
  const [a, b] = await Promise.all([first, concurrent]);
  const later = await dispatchOrchestrationHttpAction(fake.service, 'approve', payload, ctx());
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].input.requestId, undefined, 'requestId is not passed to the action');
  assert.deepEqual(a.body, { ok: true, result: { approved: 'appr-1', n: 1 } });
  assert.equal(b.body.replayed, true);
  assert.deepEqual(later.body.result, { approved: 'appr-1', n: 1 });
  assert.equal(later.body.replayed, true);
});

test('reusing a requestId for a different payload is refused with request_mismatch', async () => {
  const fake = fakeService();
  fake.release();
  await dispatchOrchestrationHttpAction(fake.service, 'approve', { id: 'appr-1', requestId: 'req-00000002' }, ctx());
  const mismatch = await dispatchOrchestrationHttpAction(fake.service, 'approve', { id: 'appr-2', requestId: 'req-00000002' }, ctx());
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'request_mismatch');
  assert.equal(fake.calls.length, 1);
});

test('receipts are scoped by caller and action, and failures are not kept', async () => {
  const fake = fakeService();
  fake.release();
  const payload = { id: 'appr-1', requestId: 'req-00000003' };
  await dispatchOrchestrationHttpAction(fake.service, 'approve', payload, ctx('pane-1'));
  await dispatchOrchestrationHttpAction(fake.service, 'approve', payload, ctx('pane-2'));
  assert.equal(fake.calls.length, 2);

  const failing = fakeService({ fail: true });
  failing.release();
  const failed = await dispatchOrchestrationHttpAction(failing.service, 'approve', payload, ctx());
  assert.equal(failed.status, 500);
  await dispatchOrchestrationHttpAction(failing.service, 'approve', payload, ctx());
  assert.equal(failing.calls.length, 2, 'a failed request runs again on retry');
});

test('malformed requestIds are rejected and calls without one are not deduplicated', async () => {
  const fake = fakeService();
  fake.release();
  const bad = await dispatchOrchestrationHttpAction(fake.service, 'approve', { id: 'a', requestId: 'x' }, ctx());
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_argument');
  await dispatchOrchestrationHttpAction(fake.service, 'approve', { id: 'a' }, ctx());
  await dispatchOrchestrationHttpAction(fake.service, 'approve', { id: 'a' }, ctx());
  assert.equal(fake.calls.length, 2);
});

test('payload hash ignores key order and presentation fields', () => {
  assert.equal(requestPayloadHash({ a: 1, b: { c: 2, d: 3 } }), requestPayloadHash({ b: { d: 3, c: 2 }, a: 1, full: true, receiptText: true }));
  assert.notEqual(requestPayloadHash({ a: 1 }), requestPayloadHash({ a: 2 }));
});

test('receipts expire after their ttl', async () => {
  let now = 0;
  const receipts = new RequestReceipts(() => now, 1_000, 10);
  let runs = 0;
  const key = { action: 'approve', caller: 'p', requestId: 'req-00000004' };
  await receipts.run(key, {}, async () => ++runs);
  now = 5_000;
  await receipts.run(key, {}, async () => ++runs);
  assert.equal(runs, 2);
});

test('the CLI sends a fresh requestId for idempotent writes and reuses --retry-request', () => {
  const fresh = withRequestId('orchestration', 'worker-integrate', { worker: 'a' }, {});
  assert.match(fresh.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(fresh.payload.requestId, fresh.requestId);
  const retry = withRequestId('orchestration', 'worker-integrate', { worker: 'a' }, { retryRequest: 'req-00000005' });
  assert.equal(retry.payload.requestId, 'req-00000005');
  assert.deepEqual(withRequestId('orchestration', 'worker-list', {}, {}), { payload: {}, requestId: null });
  assert.throws(() => withRequestId('orchestration', 'approve', {}, { retryRequest: true }), /retry-request/);
});
