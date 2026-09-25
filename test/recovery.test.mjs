import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, draftAndRun, waitSettled, lane } from './helpers.mjs';
import { openProvider } from '../src/provider.mjs';
import { payloadHash } from '../src/contracts.mjs';

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('T1 happy path: one credit, one email, one close', async () => {
  const t = await startApp();
  try {
    const { view } = await draftAndRun(t);
    const l = lane(view);
    assert.equal(l.status, 'completed');
    assert.deepEqual([l.observer.issue_credit, l.observer.send_email, l.observer.close_ticket], [1, 1, 1]);
    for (const a of l.actions) {
      assert.equal(a.status, 'confirmed');
      assert.equal(a.receipt.operationKey, a.operationKey);
      assert.equal(a.receipt.payloadHash, a.payloadHash);
    }
  } finally { await t.close(); }
});

test('T2 real worker SIGKILLed after credit commits; fresh worker reconciles without a second credit', async () => {
  const t = await startApp();
  try {
    const { runId, view } = await draftAndRun(t, { fault: 'after_commit_issue_credit' });
    let l = lane(view);
    assert.equal(l.status, 'interrupted');
    assert.equal(l.actions[0].status, 'uncertain');
    assert.deepEqual([l.observer.issue_credit, l.observer.send_email, l.observer.close_ticket], [1, 0, 0]);
    const first = l.workers[0];
    assert.equal(first.signal, 'SIGKILL');
    assert.equal(pidAlive(first.pid), false);

    const resumed = await t.api('POST', `/api/runs/${runId}/resume`, {});
    assert.equal(resumed.status, 202);
    const after = await waitSettled(t, runId);
    l = lane(after);
    assert.equal(l.status, 'completed');
    assert.deepEqual([l.observer.issue_credit, l.observer.send_email, l.observer.close_ticket], [1, 1, 1]);
    assert.equal(l.workers.length, 2);
    assert.notEqual(l.workers[1].pid, first.pid);
    assert.ok(l.events.some((e) => e.type === 'action.reconciled' && e.tool === 'issue_credit'));
    assert.equal(l.actions[0].dispatchIntents, 1, 'credit was never re-sent');

    // A8: completed runs cannot be resumed into more actions.
    const again = await t.api('POST', `/api/runs/${runId}/resume`, {});
    assert.equal(again.status, 409);
    const still = lane((await t.api('GET', `/api/runs/${runId}`)).body);
    assert.deepEqual(still.observer, l.observer);
  } finally { await t.close(); }
});

test('T3 naive retry-on-error lane double-credits under the same crash', async () => {
  const t = await startApp();
  try {
    const { runId } = await draftAndRun(t, { fault: 'after_commit_issue_credit', compare: true });
    await t.api('POST', `/api/runs/${runId}/resume`, {});
    const after = await waitSettled(t, runId);
    const receipt = lane(after, 'receipt');
    const naive = lane(after, 'naive');
    assert.equal(receipt.observer.issue_credit, 1);
    assert.equal(naive.observer.issue_credit, 2);
    assert.equal(naive.observer.creditedCents, 5000);
  } finally { await t.close(); }
});

test('T4 legacy (blind) email: crash after email commits blocks with a handoff, never resends', async () => {
  const t = await startApp();
  try {
    const { runId } = await draftAndRun(t, { profile: 'legacy_email', fault: 'after_commit_send_email' });
    const resumed = await t.api('POST', `/api/runs/${runId}/resume`, {});
    assert.equal(resumed.status, 202);
    const after = await waitSettled(t, runId);
    const l = lane(after);
    assert.equal(l.status, 'blocked');
    assert.deepEqual([l.observer.issue_credit, l.observer.send_email, l.observer.close_ticket], [1, 1, 0]);
    assert.equal(l.actions[1].status, 'blocked');
    assert.match(l.handoff, /needs a human/);
    assert.match(l.handoff, /Email outcome unknown/);
    const again = await t.api('POST', `/api/runs/${runId}/resume`, {});
    assert.equal(again.status, 409);
    assert.equal(lane((await t.api('GET', `/api/runs/${runId}`)).body).observer.send_email, 1);
  } finally { await t.close(); }
});

test('T5 provider: same key with a changed payload is a 409 conflict and adds no effect', async () => {
  const t = await startApp();
  try {
    const p = openProvider(join(t.dir, 'provider-unit.sqlite'));
    const caps = { lookup: true, idempotent: true };
    const args = { accountId: 'acct_demo', amountCents: 2500, currency: 'USD' };
    const base = { tool: 'issue_credit', runId: 'r', actionId: 'r:1', operationKey: 'receipt:r:1', caps };
    assert.equal(p.commit({ ...base, args, payloadHash: payloadHash('issue_credit', args) }).status, 'committed');
    assert.equal(p.commit({ ...base, args, payloadHash: payloadHash('issue_credit', args) }).status, 'replayed');
    const changed = { ...args, amountCents: 5000 };
    assert.equal(p.commit({ ...base, args: changed, payloadHash: payloadHash('issue_credit', changed) }).status, 'conflict');
    assert.equal(p.effects('r').length, 1);
    p.close();

    // Over HTTP, a payload that differs from the approved action is rejected before any mutation.
    const created = await t.api('POST', '/api/runs', { goal: 'credit, email, close' });
    const { runId, planHash } = created.body;
    await t.api('POST', `/api/runs/${runId}/approve`, { planHash, profile: 'standard', fault: 'none', compare: false });
    const res = await fetch(`${t.base}/tools/issue_credit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, actionId: `${runId}:1`, operationKey: `receipt:${runId}:1`, payloadHash: 'x', args: changed }),
    });
    assert.equal(res.status, 403, 'ready (not running) run cannot mutate');
    assert.equal(t.app.provider.effects(runId).length, 0);
  } finally { await t.close(); }
});

test('T6 unapproved execution and unknown tools are rejected with zero effects', async () => {
  const t = await startApp();
  try {
    const created = await t.api('POST', '/api/runs', { goal: 'credit, email, close' });
    const { runId } = created.body;
    assert.equal((await t.api('POST', `/api/runs/${runId}/start`, {})).status, 409, 'draft cannot start');
    assert.equal((await t.api('POST', `/api/runs/${runId}/approve`, { planHash: 'stale', profile: 'standard', fault: 'none' })).status, 409);
    const unknown = await fetch(`${t.base}/tools/refund_card`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unknown.status, 404);
    assert.equal(t.app.provider.effects(runId).length, 0);
    const foreign = await fetch(`${t.base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"goal":"x"}' });
    assert.equal(foreign.status, 403);
  } finally { await t.close(); }
});

test('T7 credit-only goal executes only the credit', async () => {
  const t = await startApp();
  try {
    const { view } = await draftAndRun(t, { goal: 'Apply a $10 credit only. Do not email the customer and do not close the ticket.' });
    const l = lane(view);
    assert.equal(l.status, 'completed');
    assert.equal(l.actions.length, 1);
    assert.deepEqual([l.observer.issue_credit, l.observer.send_email, l.observer.close_ticket], [1, 0, 0]);
    assert.equal(l.observer.creditedCents, 1000);
  } finally { await t.close(); }
});

test('crash after close commits: reconciles the closure, no second close', async () => {
  const t = await startApp();
  try {
    const { runId } = await draftAndRun(t, { fault: 'after_commit_close_ticket' });
    await t.api('POST', `/api/runs/${runId}/resume`, {});
    const l = lane(await waitSettled(t, runId));
    assert.equal(l.status, 'completed');
    assert.deepEqual([l.observer.issue_credit, l.observer.send_email, l.observer.close_ticket], [1, 1, 1]);
  } finally { await t.close(); }
});
