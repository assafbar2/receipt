import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configFromEnv } from '../src/server.mjs';

export async function startApp(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-test-'));
  const config = {
    ...configFromEnv({}),
    dataDir: dir,
    plannerMode: 'fixture',
    nimbleApiKey: '',
    rawtreeApiKey: '',
    port: 0,
    ...overrides,
  };
  const app = createApp(config, { fetchImpl: overrides.fetchImpl });
  const base = await app.listen(0);
  config.port = Number(new URL(base).port);
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return {
    app, base, api, dir,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(fn, { timeout = 10_000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

const SETTLED = ['completed', 'interrupted', 'blocked', 'failed'];

export async function waitSettled(t, runId) {
  return waitFor(async () => {
    const { body } = await t.api('GET', `/api/runs/${runId}`);
    const settled = body.lanes.every((l) => SETTLED.includes(l.status) && !l.active);
    return settled ? body : null;
  });
}

export async function draftAndRun(t, { goal, profile = 'standard', fault = 'none', compare = false } = {}) {
  const created = await t.api('POST', '/api/runs', { goal: goal || 'Apply the $25 credit, email, then close.' });
  if (created.status !== 201) throw new Error(`draft failed: ${JSON.stringify(created.body)}`);
  const { runId, planHash } = created.body;
  const approved = await t.api('POST', `/api/runs/${runId}/approve`, { planHash, profile, fault, compare });
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
  const started = await t.api('POST', `/api/runs/${runId}/start`, {});
  if (started.status !== 202) throw new Error(`start failed: ${JSON.stringify(started.body)}`);
  return { runId, view: await waitSettled(t, runId) };
}

export const lane = (view, policy = 'receipt') => view.lanes.find((l) => l.policy === policy);
