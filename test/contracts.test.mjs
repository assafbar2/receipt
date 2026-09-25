import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical, payloadHash, validatePlan, grade, PROFILES } from '../src/contracts.mjs';
import { extractJson, fixturePlan } from '../src/planner.mjs';
import { excerptFrom } from '../src/evidence.mjs';

const supportCase = JSON.parse(readFileSync(new URL('../fixtures/support-case.json', import.meta.url)));
const full = JSON.parse(readFileSync(new URL('../fixtures/plan-full.json', import.meta.url)));
const clone = (v) => structuredClone(v);

test('canonical JSON sorts keys recursively and hashes stably', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: 'x' } }), '{"a":{"c":"x","d":[2,1]},"b":1}');
  assert.equal(payloadHash('issue_credit', { a: 1, b: 2 }), payloadHash('issue_credit', { b: 2, a: 1 }));
  assert.notEqual(payloadHash('issue_credit', { a: 1 }), payloadHash('send_email', { a: 1 }));
});

test('valid plans: full, credit-only, and zero steps', () => {
  assert.deepEqual(validatePlan(full, supportCase), { ok: true, errors: [] });
  assert.equal(validatePlan(fixturePlan(supportCase.creditOnlyGoal), supportCase).ok, true);
  assert.equal(validatePlan({ summary: 'Outage not confirmed; no credit.', steps: [] }, supportCase).ok, true);
});

test('T6 invalid plans are rejected', () => {
  const cases = {
    'unknown tool': (p) => { p.steps[0].tool = 'refund_card'; },
    'amount over max': (p) => { p.steps[0].args.amountCents = 5001; },
    'non-integer amount': (p) => { p.steps[0].args.amountCents = 25.5; },
    'wrong recipient': (p) => { p.steps[1].args.recipient = 'attacker@example.com'; },
    'wrong account': (p) => { p.steps[0].args.accountId = 'acct_other'; },
    'bad order': (p) => { p.steps.reverse(); },
    'repeated tool': (p) => { p.steps[2] = clone(p.steps[0]); },
    'model-supplied key': (p) => { p.steps[0].operationKey = 'receipt:x:1'; },
    'extra top-level field': (p) => { p.runId = 'abc'; },
    'too many steps': (p) => { p.steps.push(clone(p.steps[2])); },
    'close without email (seen from the live model)': (p) => { p.steps.splice(1, 1); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const p = clone(full);
    mutate(p);
    assert.equal(validatePlan(p, supportCase).ok, false, name);
  }
});

test('capability grades', () => {
  assert.equal(grade(PROFILES.standard.tools.send_email), 'Receipt');
  assert.equal(grade(PROFILES.legacy_email.tools.send_email), 'Blind');
  assert.equal(grade({ lookup: false, idempotent: true }), 'Idempotent');
});

test('model output parsing strips fences and finds the first JSON object', () => {
  assert.deepEqual(extractJson('```json\n{"summary":"a","steps":[]}\n```'), { summary: 'a', steps: [] });
  assert.deepEqual(extractJson('Sure! {"a":"}{"} trailing'), { a: '}{' });
  assert.throws(() => extractJson('no json here'));
});

test('evidence excerpt starts at the Resolved heading', () => {
  const md = 'nav\n[links]\n## Resolved\n\nOn September 13, 2026, ...\n## Update\nmore';
  assert.match(excerptFrom(md), /^## Resolved/);
});
