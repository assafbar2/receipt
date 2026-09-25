import { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './contracts.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS effects (
  effect_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS effects_run ON effects(run_id);
CREATE TABLE IF NOT EXISTS receipts (
  tool TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  effect_id TEXT NOT NULL REFERENCES effects(effect_id),
  PRIMARY KEY (tool, operation_key)
);
`;

const shortId = (prefix) => `${prefix}_${newId().replace(/-/g, '').slice(0, 12)}`;

function resultFor(tool, args, committedAt) {
  if (tool === 'issue_credit') return { creditId: shortId('cr'), accountId: args.accountId, amountCents: args.amountCents, currency: args.currency };
  if (tool === 'send_email') return { messageId: shortId('em'), recipient: args.recipient, subject: args.subject };
  return { closureId: shortId('cl'), ticketId: args.ticketId, status: 'closed', closedAt: committedAt };
}

function toReceipt(row) {
  return {
    tool: row.tool,
    operationKey: row.operation_key,
    payloadHash: row.payload_hash,
    effectId: row.effect_id,
    committedAt: row.committed_at,
    result: JSON.parse(row.result_json),
  };
}

export function openProvider(path) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  return {
    close: () => db.close(),

    // One BEGIN IMMEDIATE transaction: dedupe check + effect + receipt.
    // Blind tools (no lookup, no idempotency) always insert a new effect and keep no receipt.
    commit({ tool, runId, actionId, operationKey, payloadHash, args, caps }) {
      const keepsReceipts = caps.lookup || caps.idempotent;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (caps.idempotent) {
          const existing = db.prepare(`SELECT e.* FROM receipts r JOIN effects e ON e.effect_id = r.effect_id
            WHERE r.tool = ? AND r.operation_key = ?`).get(tool, operationKey);
          if (existing) {
            db.exec('COMMIT');
            if (existing.payload_hash !== payloadHash) return { status: 'conflict' };
            return { status: 'replayed', receipt: toReceipt(existing) };
          }
        }
        const committedAt = nowIso();
        const row = {
          effect_id: newId(), run_id: runId, action_id: actionId, tool, operation_key: operationKey,
          payload_hash: payloadHash, result_json: JSON.stringify(resultFor(tool, args, committedAt)), committed_at: committedAt,
        };
        db.prepare(`INSERT INTO effects (effect_id, run_id, action_id, tool, operation_key, payload_hash, result_json, committed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.effect_id, row.run_id, row.action_id, row.tool, row.operation_key, row.payload_hash, row.result_json, row.committed_at);
        if (keepsReceipts) {
          db.prepare('INSERT INTO receipts (tool, operation_key, payload_hash, effect_id) VALUES (?, ?, ?, ?)')
            .run(tool, operationKey, payloadHash, row.effect_id);
        }
        db.exec('COMMIT');
        return { status: 'committed', receipt: toReceipt(row) };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    lookup(tool, operationKey) {
      const row = db.prepare(`SELECT e.* FROM receipts r JOIN effects e ON e.effect_id = r.effect_id
        WHERE r.tool = ? AND r.operation_key = ?`).get(tool, operationKey);
      return row ? toReceipt(row) : null;
    },

    // Observer-only view. Never exposed to workers.
    effects(runId) {
      return db.prepare('SELECT * FROM effects WHERE run_id = ? ORDER BY committed_at').all(runId);
    },

    counts(runId) {
      const rows = db.prepare('SELECT tool, result_json FROM effects WHERE run_id = ?').all(runId);
      const out = { issue_credit: 0, send_email: 0, close_ticket: 0, creditedCents: 0 };
      for (const r of rows) {
        out[r.tool] += 1;
        if (r.tool === 'issue_credit') out.creditedCents += JSON.parse(r.result_json).amountCents;
      }
      return out;
    },
  };
}
