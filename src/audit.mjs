import { isUuid } from './contracts.mjs';

export const AUDIT_TABLE = 'receipt_events';
const QUERY_LIMIT = 1000;

const str = (v) => (v === null || v === undefined ? '' : String(v));

// Runtime events plus provider events derived from committed effect rows (stable ids).
export function collectRows(store, provider, runId) {
  const run = store.getRun(runId);
  const policy = run?.policy || '';
  const rows = store.getEvents(runId).map((e) => ({
    event_id: e.event_id, run_id: e.run_id, policy, action_id: e.action_id, origin: e.origin, event_type: e.event_type,
    tool: e.tool, operation_key: e.operation_key, effect_id: e.effect_id, created_at: e.created_at, detail: e.detail,
  }));
  for (const f of provider.effects(runId)) {
    rows.push({
      event_id: `provider:${f.effect_id}`, run_id: f.run_id, policy, action_id: f.action_id, origin: 'provider',
      event_type: 'effect.committed', tool: f.tool, operation_key: f.operation_key, effect_id: f.effect_id,
      created_at: f.committed_at, detail: `Provider committed ${f.tool}`,
    });
  }
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, str(v)])));
}

function headers(config) {
  return {
    authorization: `Bearer ${config.rawtreeApiKey}`,
    'content-type': 'application/json',
    ...(config.rawtreeDatabase ? { 'x-rawtree-database': config.rawtreeDatabase } : {}),
  };
}

export async function exportRows(rows, { config, store, fetchImpl = fetch, attempts = 3 }) {
  const done = store.exportedIds();
  const pending = rows.filter((r) => !done.has(r.event_id));
  if (!pending.length) return { exported: 0 };
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${config.rawtreeBaseUrl}/v1/tables/${AUDIT_TABLE}`, {
        method: 'POST', headers: headers(config), body: JSON.stringify(pending), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`RawTree ingest HTTP ${res.status}`);
      store.markExported(pending.map((r) => r.event_id));
      return { exported: pending.length };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}

export function auditSql(runIds) {
  if (!runIds.length || !runIds.every(isUuid)) throw new Error('invalid run id');
  const list = runIds.map((id) => `'${id}'`).join(', ');
  // RawTree infers columns as Dynamic; cast before comparing or returning.
  const cols = ['event_id', 'run_id', 'policy', 'action_id', 'origin', 'event_type', 'tool', 'operation_key', 'effect_id', 'created_at', 'detail']
    .map((c) => `toString(${c}) AS ${c}`).join(', ');
  return `SELECT ${cols}
FROM ${AUDIT_TABLE}
WHERE toString(run_id) IN (${list})
ORDER BY created_at
LIMIT ${QUERY_LIMIT}`;
}

export async function queryRows(runIds, { config, fetchImpl = fetch }) {
  const sql = auditSql(runIds);
  const res = await fetchImpl(`${config.rawtreeBaseUrl}/v1/query`, {
    method: 'POST', headers: headers(config), body: JSON.stringify({ sql }), signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RawTree query HTTP ${res.status}: ${String(data?.message || data?.error || '').slice(0, 200)}`.trim());
  return { sql, rows: Array.isArray(data.data) ? data.data : [], truncated: (data.rows ?? 0) >= QUERY_LIMIT };
}

// Measured facts only, computed from the fetched RawTree rows.
export function summarize(fetched, expectedIds, runIds, policies = {}) {
  const byId = new Map();
  const FIELDS = ['event_id', 'run_id', 'policy', 'action_id', 'origin', 'event_type', 'tool', 'operation_key', 'effect_id', 'created_at', 'detail'];
  for (const raw of fetched) {
    if (!raw?.event_id) continue;
    const r = Object.fromEntries(FIELDS.map((k) => [k, str(raw[k])]));
    if (!byId.has(r.event_id)) byId.set(r.event_id, r);
  }
  const rows = [...byId.values()];
  const missing = [...expectedIds].filter((id) => !byId.has(id));

  const lanes = runIds.map((runId) => {
    const mine = rows.filter((r) => r.run_id === runId);
    const effects = {};
    for (const r of mine.filter((x) => x.origin === 'provider' && x.event_type === 'effect.committed')) {
      const key = r.action_id;
      effects[key] = effects[key] || { tool: r.tool, effectIds: new Set() };
      effects[key].effectIds.add(r.effect_id);
    }
    const perAction = Object.entries(effects).map(([actionId, v]) => ({ actionId, tool: v.tool, physicalEffects: v.effectIds.size }));
    const lastRunEvent = mine.filter((r) => r.event_type.startsWith('run.') && r.event_type !== 'run.approved').at(-1);
    return {
      runId,
      policy: policies[runId] || mine[0]?.policy || '',
      events: mine.length,
      interruptions: mine.filter((r) => r.event_type === 'worker.exited' && /SIGKILL/.test(r.detail)).length,
      reconciled: mine.filter((r) => r.event_type === 'action.reconciled').length,
      perAction,
      duplicates: perAction.some((a) => a.physicalEffects > 1),
      status: lastRunEvent ? lastRunEvent.event_type.replace('run.', '') : 'unknown',
      blockedTool: mine.filter((r) => r.event_type === 'action.blocked').at(-1)?.tool || '',
    };
  });
  return { rows: rows.length, missing: missing.length, lanes };
}

export async function runAudit({ runIds, store, provider, config, fetchImpl = fetch }) {
  const local = runIds.flatMap((id) => collectRows(store, provider, id));
  const expectedIds = new Set(local.map((r) => r.event_id));
  if (!config.rawtreeApiKey) {
    return { status: 'unavailable', reason: 'RAWTREE_API_KEY not set', expected: expectedIds.size };
  }
  try {
    await exportRows(local, { config, store, fetchImpl });
  } catch (err) {
    return { status: 'unavailable', reason: `Export failed: ${err.message}`, expected: expectedIds.size };
  }
  let fetched;
  try {
    fetched = await queryRows(runIds, { config, fetchImpl });
  } catch (err) {
    return { status: 'pending', reason: `Query not ready: ${err.message}`, expected: expectedIds.size };
  }
  const policies = Object.fromEntries(runIds.map((id) => [id, store.getRun(id)?.policy || '']));
  const summary = summarize(fetched.rows, expectedIds, runIds, policies);
  const complete = summary.missing === 0 && !fetched.truncated;
  return {
    status: complete ? 'live' : 'pending',
    reason: complete ? 'All local events present in RawTree' : `${summary.missing} of ${expectedIds.size} events not yet visible${fetched.truncated ? '; result truncated' : ''}`,
    expected: expectedIds.size,
    sql: fetched.sql,
    ...summary,
  };
}
