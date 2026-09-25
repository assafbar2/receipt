import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, draftAndRun, waitSettled, lane } from './helpers.mjs';
import { auditSql, summarize } from '../src/audit.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeRawTree({ failIngest = false, drop = 0, duplicate = false } = {}) {
  const table = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v1/tables/receipt_events')) {
      if (failIngest) return json(503, { error: 'down' });
      const rows = JSON.parse(init.body);
      table.push(...rows);
      if (duplicate) table.push(...rows);
      return json(200, { inserted: rows.length });
    }
    if (url.endsWith('/v1/query')) {
      const data = table.slice(drop);
      return json(200, { meta: [], data, rows: data.length });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, table };
}

const cfg = (fetchImpl) => ({ rawtreeApiKey: 'rt_test', rawtreeBaseUrl: 'https://rawtree.test', fetchImpl });

test('T8 audit is live and complete; duplicates are deduplicated by event_id', async () => {
  const fake = fakeRawTree({ duplicate: true });
  const t = await startApp(cfg(fake.fetchImpl));
  try {
    const { runId } = await draftAndRun(t, { fault: 'after_commit_issue_credit', compare: true });
    const mid = await t.api('POST', `/api/runs/${runId}/audit`, {});
    assert.equal(mid.body.status, 'live');
    await t.api('POST', `/api/runs/${runId}/resume`, {});
    await waitSettled(t, runId);
    const report = (await t.api('POST', `/api/runs/${runId}/audit`, {})).body;
    assert.equal(report.status, 'live');
    const receiptLane = report.lanes.find((l) => l.policy === 'receipt');
    const naiveLane = report.lanes.find((l) => l.policy === 'naive');
    assert.equal(receiptLane.duplicates, false);
    assert.equal(receiptLane.interruptions, 1);
    assert.equal(receiptLane.reconciled, 1);
    assert.ok(receiptLane.perAction.every((a) => a.physicalEffects === 1));
    assert.equal(naiveLane.duplicates, true);
    assert.equal(naiveLane.perAction.find((a) => a.tool === 'issue_credit').physicalEffects, 2);
  } finally { await t.close(); }
});

test('T8 RawTree down: execution unaffected, report unavailable, never falsely live', async () => {
  const fake = fakeRawTree({ failIngest: true });
  const t = await startApp(cfg(fake.fetchImpl));
  try {
    const { runId, view } = await draftAndRun(t);
    assert.equal(lane(view).status, 'completed');
    const report = (await t.api('POST', `/api/runs/${runId}/audit`, {})).body;
    assert.equal(report.status, 'unavailable');
  } finally { await t.close(); }
});

test('T8 partial RawTree results are reported as pending, not zero effects', async () => {
  const fake = fakeRawTree({ drop: 3 });
  const t = await startApp(cfg(fake.fetchImpl));
  try {
    const { runId } = await draftAndRun(t);
    const report = (await t.api('POST', `/api/runs/${runId}/audit`, {})).body;
    assert.equal(report.status, 'pending');
    assert.ok(report.missing > 0);
  } finally { await t.close(); }
});

test('audit SQL only accepts validated UUIDs', () => {
  assert.throws(() => auditSql(["x' OR 1=1 --"]));
  assert.match(auditSql(['00000000-0000-4000-8000-000000000000']), /LIMIT 1000/);
  const s = summarize([{ event_id: 'a', run_id: 'r' }, { event_id: 'a', run_id: 'r' }], new Set(['a', 'b']), ['r']);
  assert.equal(s.rows, 1);
  assert.equal(s.missing, 1);
});
