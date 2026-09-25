import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  FAULTS, PROFILES, TOOLS, capabilities, grade, handoffNote, isUuid, newId, parseKey, payloadHash, planHash, validatePlan,
} from './contracts.mjs';
import { openRuntime, Conflict } from './store.mjs';
import { openProvider } from './provider.mjs';
import { generatePlan, PlannerError } from './planner.mjs';
import { fetchEvidence } from './evidence.mjs';
import { runAudit } from './audit.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const WORKER = join(ROOT, 'src', 'worker.mjs');
const SUPPORT_CASE = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'support-case.json'), 'utf8'));

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT || 4317),
    dataDir: resolve(env.DATA_DIR || join(ROOT, 'data')),
    plannerMode: env.PLANNER_MODE === 'fixture' ? 'fixture' : 'live',
    llmBaseUrl: env.LLM_BASE_URL || '',
    llmModel: env.LLM_MODEL || '',
    llmApiKey: env.LLM_API_KEY || '',
    nimbleBaseUrl: env.NIMBLE_BASE_URL || 'https://sdk.nimbleway.com',
    nimbleApiKey: env.NIMBLE_API_KEY || '',
    statusPageUrl: env.STATUS_PAGE_URL || '',
    rawtreeBaseUrl: env.RAWTREE_BASE_URL || 'https://api.rawtree.com',
    rawtreeApiKey: env.RAWTREE_API_KEY || '',
    rawtreeDatabase: env.RAWTREE_DATABASE || '',
  };
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function createApp(config, deps = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const runtimeDb = join(config.dataDir, 'runtime.sqlite');
  const store = openRuntime(runtimeDb);
  const provider = openProvider(join(config.dataDir, 'provider.sqlite'));
  const children = new Map();
  const evidenceCache = new Map();
  const fetchImpl = deps.fetchImpl || fetch;
  let providerUrl = '';

  // A supervisor restart cannot own old children; treat their runs as interrupted.
  for (const run of store.db.prepare(`SELECT run_id FROM runs WHERE status = 'running'`).all()) {
    store.interrupt(run.run_id, null, 'Supervisor restarted while run was active');
  }

  function spawnWorker(runId, mode) {
    if (children.has(runId)) throw new HttpError(409, 'A worker is already active for this run.');
    try {
      store.beginExecution(runId, mode);
    } catch (err) {
      if (err instanceof Conflict) throw new HttpError(409, err.message);
      throw err;
    }
    const child = spawn(process.execPath, ['--no-warnings', WORKER, runId], {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { RECEIPT_RUNTIME_DB: runtimeDb, RECEIPT_PROVIDER_URL: providerUrl, NODE_NO_WARNINGS: '1' },
    });
    children.set(runId, child);
    store.workerStarted(runId, child.pid, mode);
    child.stderr.on('data', (d) => process.stderr.write(`[worker ${child.pid}] ${d}`));
    child.stdout.on('data', (d) => process.stdout.write(`[worker ${child.pid}] ${d}`));
    child.on('exit', (code, signal) => {
      children.delete(runId);
      store.workerExited(runId, child.pid, code, signal);
    });
    return child.pid;
  }

  function lanesFor(runId) {
    const primary = store.getRun(runId);
    if (!primary || primary.policy !== 'receipt') throw new HttpError(404, 'Run not found.');
    const twin = store.getPair(runId);
    return [primary, twin].filter(Boolean);
  }

  function laneView(run) {
    const actions = store.getActions(run.run_id);
    return {
      runId: run.run_id,
      policy: run.policy,
      status: run.status,
      profile: run.provider_profile,
      fault: JSON.parse(run.fault_json),
      faultConsumed: Boolean(run.fault_consumed),
      active: children.has(run.run_id),
      workers: store.getWorkers(run.run_id).map((w) => ({ pid: w.pid, startedAt: w.started_at, exitedAt: w.exited_at, exitCode: w.exit_code, signal: w.signal, alive: !w.exited_at })),
      actions: actions.map((a) => ({
        actionId: a.action_id, ordinal: a.ordinal, tool: a.tool, args: JSON.parse(a.args_json), status: a.status,
        operationKey: a.operation_key, payloadHash: a.payload_hash, dispatchIntents: a.dispatch_intents,
        receipt: a.receipt_json ? JSON.parse(a.receipt_json) : null, errorCode: a.error_code,
      })),
      events: store.getEvents(run.run_id).map((e) => ({ at: e.created_at, origin: e.origin, type: e.event_type, tool: e.tool, operationKey: e.operation_key, effectId: e.effect_id, detail: e.detail })),
      observer: provider.counts(run.run_id),
      handoff: handoffNote(run, actions),
    };
  }

  function runView(runId) {
    const lanes = lanesFor(runId);
    const p = lanes[0];
    const profile = p.provider_profile;
    return {
      runId: p.run_id,
      goal: p.goal,
      status: p.status,
      plan: JSON.parse(p.plan_json),
      planHash: p.plan_hash,
      plannerMode: p.planner_mode,
      plannerModel: p.planner_model,
      evidence: JSON.parse(p.evidence_json),
      readiness: TOOLS.map((t) => ({ tool: t, grade: grade(PROFILES[profile].tools[t]), ...PROFILES[profile].tools[t] })),
      lanes: lanes.map(laneView),
    };
  }

  // ---------------- provider simulator ----------------

  function providerDispatch(req, res, tool, body) {
    if (!TOOLS.includes(tool)) throw new HttpError(404, `Unknown tool ${tool}.`);
    const { runId, actionId, operationKey, payloadHash: hash, args } = body || {};
    if (!isUuid(runId)) throw new HttpError(400, 'Invalid runId.');
    const run = store.getRun(runId);
    if (!run || run.status !== 'running') throw new HttpError(403, 'Run is not approved and executing.');
    const action = store.getAction(actionId);
    if (!action || action.run_id !== runId || action.tool !== tool) throw new HttpError(403, 'Action is not part of the approved plan.');
    if (hash !== action.payload_hash || payloadHash(tool, args) !== action.payload_hash) {
      throw new HttpError(422, 'Payload does not match the approved action.');
    }
    const key = parseKey(operationKey);
    const keyOk = run.policy === 'receipt'
      ? operationKey === action.operation_key
      : key && key.policy === 'naive' && key.runId === runId && key.ordinal === action.ordinal;
    if (!keyOk) throw new HttpError(422, 'Operation key does not match the approved action.');

    const caps = capabilities(run.provider_profile, tool);
    const out = provider.commit({ tool, runId, actionId, operationKey, payloadHash: hash, args, caps });
    if (out.status === 'conflict') throw new HttpError(409, 'Operation key already used with a different payload.');

    const fault = JSON.parse(run.fault_json);
    if (out.status === 'committed' && fault.type === 'after_commit' && fault.tool === tool && !run.fault_consumed) {
      if (store.consumeFault(runId)) {
        children.get(runId)?.kill('SIGKILL');
        req.socket.destroy();
        return;
      }
    }
    sendJson(res, 200, { receipt: out.receipt, replayed: out.status === 'replayed' });
  }

  function providerLookup(res, tool, operationKey) {
    if (!TOOLS.includes(tool)) throw new HttpError(404, `Unknown tool ${tool}.`);
    const key = parseKey(operationKey);
    const run = key && store.getRun(key.runId);
    if (!run) return sendJson(res, 200, { status: 'not_found' });
    if (!capabilities(run.provider_profile, tool).lookup) return sendJson(res, 200, { status: 'unsupported' });
    const receipt = provider.lookup(tool, operationKey);
    sendJson(res, 200, receipt ? { status: 'found', receipt } : { status: 'not_found' });
  }

  // ---------------- application routes ----------------

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    if (parts[0] === 'tools') {
      if (method === 'GET' && parts[1] === 'receipts' && parts.length === 4) return providerLookup(res, parts[2], decodeURIComponent(parts[3]));
      if (method === 'POST' && parts.length === 2) return providerDispatch(req, res, parts[1], await readJson(req));
      throw new HttpError(404, 'Not found.');
    }

    if (parts[0] === 'api') {
      if (method === 'POST') guardBrowser(req, config.port);
      if (method === 'GET' && parts[1] === 'config') {
        return sendJson(res, 200, {
          plannerMode: config.plannerMode,
          plannerModel: config.plannerMode === 'live' ? config.llmModel : '',
          services: {
            planner: config.plannerMode === 'live' && Boolean(config.llmApiKey),
            nimble: Boolean(config.nimbleApiKey),
            rawtree: Boolean(config.rawtreeApiKey),
          },
          supportCase: SUPPORT_CASE,
          profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, { label: p.label, tools: TOOLS.map((t) => ({ tool: t, grade: grade(p.tools[t]) })) }])),
          faults: Object.keys(FAULTS),
        });
      }
      if (method === 'POST' && parts[1] === 'evidence' && parts.length === 2) {
        const evidence = await fetchEvidence({ config, fetchImpl });
        const evidenceId = newId();
        evidenceCache.set(evidenceId, evidence);
        return sendJson(res, 200, { evidenceId, evidence });
      }
      if (method === 'POST' && parts[1] === 'runs' && parts.length === 2) {
        const body = await readJson(req);
        const goal = String(body.goal || '').trim();
        if (!goal || goal.length > 1000) throw new HttpError(400, 'Goal must be 1-1000 characters.');
        const evidence = body.evidenceId ? evidenceCache.get(body.evidenceId) || null : null;
        let result;
        try {
          result = await generatePlan({ goal, supportCase: SUPPORT_CASE, evidence, config, fetchImpl });
        } catch (err) {
          if (err instanceof PlannerError) throw new HttpError(502, err.message, { raw: err.raw });
          throw err;
        }
        const check = validatePlan(result.plan, SUPPORT_CASE);
        if (!check.ok) {
          throw new HttpError(422, 'The model proposed a plan that failed validation. Nothing was executed.', {
            errors: check.errors, raw: result.raw || JSON.stringify(result.plan), plannerMode: result.mode,
          });
        }
        const runId = store.createDraft({
          goal, supportCase: SUPPORT_CASE, evidence, plan: result.plan, planHash: planHash(result.plan),
          plannerMode: result.mode, plannerModel: result.model,
        });
        return sendJson(res, 201, runView(runId));
      }
      if (parts[1] === 'runs' && parts[2]) {
        const runId = parts[2];
        if (!isUuid(runId)) throw new HttpError(400, 'Invalid run id.');
        const action = parts[3] || '';
        if (method === 'GET' && !action) return sendJson(res, 200, runView(runId));
        if (method === 'POST' && action === 'approve') {
          const body = await readJson(req);
          const run = lanesFor(runId)[0];
          if (body.planHash !== run.plan_hash) throw new HttpError(409, 'Plan changed since review. Regenerate and review again.');
          if (!PROFILES[body.profile]) throw new HttpError(400, 'Unknown provider profile.');
          if (!FAULTS[body.fault]) throw new HttpError(400, 'Unknown fault.');
          try {
            store.approve(runId, { profile: body.profile, faultId: body.fault, compare: body.compare !== false });
          } catch (err) {
            if (err instanceof Conflict) throw new HttpError(409, err.message);
            throw err;
          }
          return sendJson(res, 200, runView(runId));
        }
        if (method === 'POST' && (action === 'start' || action === 'resume')) {
          await readJson(req);
          const lanes = lanesFor(runId);
          const wanted = action === 'start' ? 'ready' : 'interrupted';
          const targets = lanes.filter((l) => l.status === wanted);
          if (lanes.some((l) => children.has(l.run_id))) throw new HttpError(409, 'A worker is already active for this run.');
          if (!targets.length) throw new HttpError(409, `No lane is ${wanted}; nothing to ${action}.`);
          const pids = targets.map((l) => spawnWorker(l.run_id, action));
          return sendJson(res, 202, { pids, run: runView(runId) });
        }
        if (method === 'POST' && action === 'audit') {
          await readJson(req);
          const lanes = lanesFor(runId);
          if (lanes.some((l) => l.status === 'running' || children.has(l.run_id))) throw new HttpError(409, 'Wait for workers to stop before auditing.');
          if (lanes[0].status === 'draft' || lanes[0].status === 'ready') throw new HttpError(409, 'Nothing to audit yet.');
          const report = await runAudit({ runIds: lanes.map((l) => l.run_id), store, provider, config, fetchImpl });
          return sendJson(res, 200, report);
        }
      }
      throw new HttpError(404, 'Not found.');
    }

    if (method === 'GET') return serveStatic(res, url.pathname);
    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent || req.socket.destroyed) return;
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      sendJson(res, 500, { error: 'Internal error.' });
    });
  });

  return {
    store,
    provider,
    children,
    listen(port = config.port) {
      return new Promise((ok) => server.listen(port, '127.0.0.1', () => {
        providerUrl = `http://127.0.0.1:${server.address().port}`;
        ok(providerUrl);
      }));
    },
    async close() {
      for (const c of children.values()) c.kill('SIGKILL');
      await new Promise((ok) => server.close(ok));
      server.closeAllConnections?.();
      store.close();
      provider.close();
    },
  };
}

function guardBrowser(req, port) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) {
    throw new HttpError(403, 'Foreign origin rejected.');
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'Not found.');
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

// The project .env wins over inherited shell variables (e.g. a global LLM_MODEL).
function loadEnvFile() {
  const file = join(ROOT, '.env');
  const fromFile = existsSync(file)
    ? Object.fromEntries(Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(([, v]) => v !== ''))
    : {};
  const override = process.env.PLANNER_MODE_OVERRIDE ? { PLANNER_MODE: process.env.PLANNER_MODE_OVERRIDE } : {};
  return { ...process.env, ...fromFile, ...override };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configFromEnv(loadEnvFile());
  const app = createApp(config);
  const url = await app.listen();
  console.log(`RECEIPT running at ${url}  (planner: ${config.plannerMode}${config.plannerMode === 'live' ? `, ${config.llmModel}` : ''})`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
