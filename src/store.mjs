import { DatabaseSync } from 'node:sqlite';
import {
  actionId, receiptKey, naiveKey, payloadHash, newId, nowIso, FAULTS, PROFILES, POLICIES,
} from './contracts.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL DEFAULT 'receipt',
  goal TEXT NOT NULL,
  case_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT 'null',
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  planner_mode TEXT NOT NULL,
  planner_model TEXT NOT NULL DEFAULT '',
  provider_profile TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT '',
  fault_json TEXT NOT NULL DEFAULT '{"type":"none"}',
  fault_consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  ordinal INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  dispatch_intents INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  UNIQUE (run_id, ordinal)
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  action_id TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  operation_key TEXT NOT NULL DEFAULT '',
  effect_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, created_at);
CREATE TABLE IF NOT EXISTS workers (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  exited_at TEXT NOT NULL DEFAULT '',
  exit_code TEXT NOT NULL DEFAULT '',
  signal TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, pid)
);
CREATE TABLE IF NOT EXISTS audit_exports (
  event_id TEXT PRIMARY KEY,
  exported_at TEXT NOT NULL
);
`;

export function openRuntime(path) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return new RuntimeStore(db);
}

class RuntimeStore {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  event(runId, e) {
    this.db.prepare(`INSERT INTO events (event_id, run_id, action_id, origin, event_type, tool, operation_key, effect_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newId(), runId, e.actionId || '', e.origin || 'runtime', e.type, e.tool || '',
      e.operationKey || '', e.effectId || '', e.detail || '', nowIso(),
    );
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) || null;
  }

  getPair(runId) {
    return this.db.prepare('SELECT * FROM runs WHERE pair_id = ? AND run_id != ?').get(runId, runId) || null;
  }

  getActions(runId) {
    return this.db.prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY ordinal').all(runId);
  }

  getAction(id) {
    return this.db.prepare('SELECT * FROM actions WHERE action_id = ?').get(id) || null;
  }

  getEvents(runId) {
    return this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY created_at, rowid').all(runId);
  }

  getWorkers(runId) {
    return this.db.prepare('SELECT * FROM workers WHERE run_id = ? ORDER BY started_at').all(runId);
  }

  createDraft({ goal, supportCase, evidence, plan, planHash, plannerMode, plannerModel }) {
    const runId = newId();
    this.tx(() => {
      this.db.prepare(`INSERT INTO runs (run_id, pair_id, policy, goal, case_json, evidence_json, plan_json, plan_hash, planner_mode, planner_model, status, created_at)
        VALUES (?, ?, 'receipt', ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`).run(
        runId, runId, goal, JSON.stringify(supportCase), JSON.stringify(evidence ?? null),
        JSON.stringify(plan), planHash, plannerMode, plannerModel || '', nowIso(),
      );
      this.event(runId, {
        origin: 'supervisor', type: 'plan.generated',
        detail: `${plan.steps.length}-step plan from ${plannerMode === 'live' ? `live model ${plannerModel}` : 'fixture planner'}`,
      });
    });
    return runId;
  }

  // Freezes the plan and creates stable actions. Optionally creates a naive "retry on error" twin.
  approve(runId, { profile, faultId, compare }) {
    if (!PROFILES[profile]) throw new Error('unknown profile');
    if (!FAULTS[faultId]) throw new Error('unknown fault');
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== 'draft' || run.policy !== 'receipt') throw new Conflict('Run is not an approvable draft.');
      const fault = JSON.stringify(FAULTS[faultId]);
      const approvedAt = nowIso();
      const ids = [runId];
      this.db.prepare(`UPDATE runs SET status = 'ready', provider_profile = ?, fault_json = ?, approved_at = ? WHERE run_id = ?`)
        .run(profile, fault, approvedAt, runId);
      if (compare) {
        const twin = newId();
        this.db.prepare(`INSERT INTO runs (run_id, pair_id, policy, goal, case_json, evidence_json, plan_json, plan_hash, planner_mode, planner_model, provider_profile, status, approved_at, fault_json, created_at)
          SELECT ?, run_id, 'naive', goal, case_json, evidence_json, plan_json, plan_hash, planner_mode, planner_model, ?, 'ready', ?, ?, ? FROM runs WHERE run_id = ?`)
          .run(twin, profile, approvedAt, fault, nowIso(), runId);
        ids.push(twin);
      }
      const plan = JSON.parse(run.plan_json);
      for (const id of ids) {
        const policy = id === runId ? 'receipt' : 'naive';
        plan.steps.forEach((step, i) => {
          const ordinal = i + 1;
          const key = policy === 'receipt' ? receiptKey(id, ordinal) : naiveKey(id, ordinal, 1);
          this.db.prepare(`INSERT INTO actions (action_id, run_id, ordinal, tool, args_json, operation_key, payload_hash, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
            actionId(id, ordinal), id, ordinal, step.tool, JSON.stringify(step.args), key, payloadHash(step.tool, step.args),
          );
        });
        this.event(id, {
          origin: 'supervisor', type: 'run.approved',
          detail: `Plan frozen (${plan.steps.length} actions, ${PROFILES[profile].label}, fault: ${faultId}, policy: ${policy})`,
        });
      }
      return ids;
    });
  }

  // Supervisor-only: moves a run to running before spawning its worker.
  beginExecution(runId, mode) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new Conflict('Run not found.');
      const allowed = mode === 'start' ? ['ready'] : ['interrupted'];
      if (!allowed.includes(run.status)) throw new Conflict(`Cannot ${mode} a run that is ${run.status}.`);
      if (mode === 'resume') {
        for (const a of this.getActions(runId).filter((x) => x.status === 'in_flight')) {
          this.db.prepare(`UPDATE actions SET status = 'uncertain' WHERE action_id = ?`).run(a.action_id);
          this.event(runId, { origin: 'supervisor', type: 'action.uncertain', actionId: a.action_id, tool: a.tool, operationKey: a.operation_key, detail: 'In-flight action found on resume; outcome unknown' });
        }
      }
      this.db.prepare(`UPDATE runs SET status = 'running' WHERE run_id = ?`).run(runId);
      return run;
    });
  }

  workerStarted(runId, pid, mode) {
    this.tx(() => {
      this.db.prepare('INSERT INTO workers (run_id, pid, started_at) VALUES (?, ?, ?)').run(runId, pid, nowIso());
      this.event(runId, { origin: 'supervisor', type: 'worker.started', detail: `${mode === 'start' ? 'Worker' : 'Fresh worker'} started (pid ${pid})` });
    });
  }

  workerExited(runId, pid, code, signal) {
    this.tx(() => {
      this.db.prepare('UPDATE workers SET exited_at = ?, exit_code = ?, signal = ? WHERE run_id = ? AND pid = ?')
        .run(nowIso(), code === null ? '' : String(code), signal || '', runId, pid);
      this.event(runId, { origin: 'supervisor', type: 'worker.exited', detail: `Worker pid ${pid} exited (${signal ? `signal ${signal}` : `code ${code}`})` });
      const run = this.getRun(runId);
      if (run.status === 'running') {
        for (const a of this.getActions(runId).filter((x) => x.status === 'in_flight')) {
          this.db.prepare(`UPDATE actions SET status = 'uncertain' WHERE action_id = ?`).run(a.action_id);
          this.event(runId, { origin: 'supervisor', type: 'action.uncertain', actionId: a.action_id, tool: a.tool, operationKey: a.operation_key, detail: 'Worker died after dispatch; outcome unknown to the agent' });
        }
        this.db.prepare(`UPDATE runs SET status = 'interrupted' WHERE run_id = ?`).run(runId);
        this.event(runId, { origin: 'supervisor', type: 'run.interrupted', detail: 'Run interrupted by worker exit' });
      }
    });
  }

  consumeFault(runId) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (run.fault_consumed) return false;
      this.db.prepare('UPDATE runs SET fault_consumed = 1 WHERE run_id = ?').run(runId);
      const fault = JSON.parse(run.fault_json);
      this.event(runId, { origin: 'supervisor', type: 'fault.fired', tool: fault.tool, detail: `Provider committed ${fault.tool}; killing worker before it receives the response` });
      return true;
    });
  }

  // ---- worker-side transitions ----

  markInFlight(action, policy) {
    return this.tx(() => {
      const intents = action.dispatch_intents + 1;
      let key = action.operation_key;
      if (policy === 'naive' && intents > 1) {
        key = naiveKey(action.run_id, action.ordinal, intents);
      }
      this.db.prepare(`UPDATE actions SET status = 'in_flight', dispatch_intents = ?, operation_key = ? WHERE action_id = ?`)
        .run(intents, key, action.action_id);
      this.event(action.run_id, {
        type: 'action.dispatching', actionId: action.action_id, tool: action.tool, operationKey: key,
        detail: intents > 1 ? `Re-dispatching (attempt ${intents})${policy === 'naive' ? ' with a new key' : ' with the same key'}` : 'Intent recorded; dispatching',
      });
      return this.getAction(action.action_id);
    });
  }

  confirm(action, receipt, type, detail) {
    this.tx(() => {
      this.db.prepare(`UPDATE actions SET status = 'confirmed', receipt_json = ?, error_code = '' WHERE action_id = ?`)
        .run(JSON.stringify(receipt), action.action_id);
      this.event(action.run_id, { type, actionId: action.action_id, tool: action.tool, operationKey: action.operation_key, effectId: receipt.effectId, detail });
    });
  }

  markUncertainAndInterrupt(action, detail) {
    this.tx(() => {
      this.db.prepare(`UPDATE actions SET status = 'uncertain' WHERE action_id = ?`).run(action.action_id);
      this.event(action.run_id, { type: 'action.uncertain', actionId: action.action_id, tool: action.tool, operationKey: action.operation_key, detail });
      this.db.prepare(`UPDATE runs SET status = 'interrupted' WHERE run_id = ?`).run(action.run_id);
      this.event(action.run_id, { type: 'run.interrupted', detail: 'Stopped with an unresolved action' });
    });
  }

  interrupt(runId, action, detail) {
    this.tx(() => {
      this.db.prepare(`UPDATE runs SET status = 'interrupted' WHERE run_id = ?`).run(runId);
      this.event(runId, { type: 'run.interrupted', actionId: action?.action_id, tool: action?.tool, operationKey: action?.operation_key, detail });
    });
  }

  block(action, code, detail) {
    this.tx(() => {
      this.db.prepare(`UPDATE actions SET status = 'blocked', error_code = ? WHERE action_id = ?`).run(code, action.action_id);
      this.event(action.run_id, { type: 'action.blocked', actionId: action.action_id, tool: action.tool, operationKey: action.operation_key, detail });
      this.db.prepare(`UPDATE runs SET status = 'blocked' WHERE run_id = ?`).run(action.run_id);
      this.event(action.run_id, { type: 'run.blocked', detail: 'Execution stopped; human handoff required' });
    });
  }

  fail(action, code, detail) {
    this.tx(() => {
      this.db.prepare(`UPDATE actions SET status = 'failed', error_code = ? WHERE action_id = ?`).run(code, action.action_id);
      this.event(action.run_id, { type: 'action.failed', actionId: action.action_id, tool: action.tool, operationKey: action.operation_key, detail });
      this.db.prepare(`UPDATE runs SET status = 'failed' WHERE run_id = ?`).run(action.run_id);
      this.event(action.run_id, { type: 'run.failed', detail });
    });
  }

  complete(runId) {
    this.tx(() => {
      this.db.prepare(`UPDATE runs SET status = 'completed' WHERE run_id = ?`).run(runId);
      this.event(runId, { type: 'run.completed', detail: 'All approved actions confirmed' });
    });
  }

  // ---- audit export bookkeeping ----

  exportedIds() {
    return new Set(this.db.prepare('SELECT event_id FROM audit_exports').all().map((r) => r.event_id));
  }

  markExported(ids) {
    this.tx(() => {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO audit_exports (event_id, exported_at) VALUES (?, ?)');
      const at = nowIso();
      for (const id of ids) stmt.run(id, at);
    });
  }
}

export class Conflict extends Error {}

export { POLICIES };
