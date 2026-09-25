import { createHash, randomUUID } from 'node:crypto';

export const TOOLS = ['issue_credit', 'send_email', 'close_ticket'];

export const TOOL_ARGS = {
  issue_credit: ['accountId', 'amountCents', 'currency'],
  send_email: ['recipient', 'subject', 'body'],
  close_ticket: ['ticketId'],
};

export const LIMITS = { summary: 300, subject: 160, body: 2000 };

// Server-controlled provider capabilities. The model never supplies these.
export const PROFILES = {
  standard: {
    label: 'Standard providers',
    tools: {
      issue_credit: { lookup: true, idempotent: true },
      send_email: { lookup: true, idempotent: true },
      close_ticket: { lookup: true, idempotent: true },
    },
  },
  legacy_email: {
    label: 'Legacy email provider',
    tools: {
      issue_credit: { lookup: true, idempotent: true },
      send_email: { lookup: false, idempotent: false },
      close_ticket: { lookup: true, idempotent: true },
    },
  },
};

export const FAULTS = {
  none: { type: 'none' },
  after_commit_issue_credit: { type: 'after_commit', tool: 'issue_credit' },
  after_commit_send_email: { type: 'after_commit', tool: 'send_email' },
  after_commit_close_ticket: { type: 'after_commit', tool: 'close_ticket' },
};

export const POLICIES = ['receipt', 'naive'];

export function grade(cap) {
  if (cap.lookup) return 'Receipt';
  if (cap.idempotent) return 'Idempotent';
  return 'Blind';
}

export function capabilities(profile, tool) {
  const p = PROFILES[profile];
  if (!p || !p.tools[tool]) throw new Error(`unknown profile/tool ${profile}/${tool}`);
  return p.tools[tool];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
export const newId = () => randomUUID();
export const nowIso = () => new Date().toISOString();

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const payloadHash = (tool, args) => sha256(canonical({ tool, args }));
export const planHash = (plan) => sha256(canonical(plan));

export const actionId = (runId, ordinal) => `${runId}:${ordinal}`;
export const receiptKey = (runId, ordinal) => `receipt:${runId}:${ordinal}`;
export const naiveKey = (runId, ordinal, attempt) => `naive:${runId}:${ordinal}:${attempt}`;

export function parseKey(key) {
  const m = /^(receipt|naive):([0-9a-f-]{36}):(\d+)(?::(\d+))?$/.exec(key || '');
  if (!m || !isUuid(m[2])) return null;
  return { policy: m[1], runId: m[2], ordinal: Number(m[3]), attempt: m[4] ? Number(m[4]) : null };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function validatePlan(plan, supportCase) {
  const errors = [];
  if (!isPlainObject(plan)) return { ok: false, errors: ['Plan must be a JSON object.'] };

  const extraTop = Object.keys(plan).filter((k) => !['summary', 'steps'].includes(k));
  if (extraTop.length) errors.push(`Unknown top-level fields: ${extraTop.join(', ')}.`);
  if (!nonEmptyString(plan.summary, LIMITS.summary)) {
    errors.push(`summary must be a non-empty string of at most ${LIMITS.summary} characters.`);
  }
  if (!Array.isArray(plan.steps)) {
    errors.push('steps must be an array.');
    return { ok: false, errors };
  }
  if (plan.steps.length > 3) errors.push('At most 3 steps are allowed.');

  let lastIndex = -1;
  const seen = new Set();
  plan.steps.forEach((step, i) => {
    const at = `Step ${i + 1}`;
    if (!isPlainObject(step)) return errors.push(`${at} must be an object.`);
    const extra = Object.keys(step).filter((k) => !['tool', 'args'].includes(k));
    if (extra.length) errors.push(`${at} has unknown fields: ${extra.join(', ')}.`);
    const idx = TOOLS.indexOf(step.tool);
    if (idx === -1) return errors.push(`${at} uses unknown tool "${step.tool}".`);
    if (seen.has(step.tool)) errors.push(`${at} repeats tool ${step.tool}.`);
    seen.add(step.tool);
    if (idx < lastIndex) errors.push(`${at}: ${step.tool} is out of order (credit, email, close).`);
    lastIndex = Math.max(lastIndex, idx);

    const args = step.args;
    if (!isPlainObject(args)) return errors.push(`${at} args must be an object.`);
    const allowed = TOOL_ARGS[step.tool];
    const extraArgs = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extraArgs.length) errors.push(`${at} has unknown args: ${extraArgs.join(', ')}.`);
    const missing = allowed.filter((k) => !(k in args));
    if (missing.length) errors.push(`${at} is missing args: ${missing.join(', ')}.`);

    if (step.tool === 'issue_credit') {
      if (args.accountId !== supportCase.accountId) errors.push(`${at}: accountId must be ${supportCase.accountId}.`);
      if (args.currency !== supportCase.currency) errors.push(`${at}: currency must be ${supportCase.currency}.`);
      if (!Number.isInteger(args.amountCents)) errors.push(`${at}: amountCents must be an integer.`);
      else if (args.amountCents <= 0 || args.amountCents > supportCase.maxCreditCents) {
        errors.push(`${at}: amountCents must be between 1 and ${supportCase.maxCreditCents}.`);
      }
    }
    if (step.tool === 'send_email') {
      if (args.recipient !== supportCase.recipient) errors.push(`${at}: recipient must be ${supportCase.recipient}.`);
      if (!nonEmptyString(args.subject, LIMITS.subject)) errors.push(`${at}: subject must be 1-${LIMITS.subject} characters.`);
      if (!nonEmptyString(args.body, LIMITS.body)) errors.push(`${at}: body must be 1-${LIMITS.body} characters.`);
    }
    if (step.tool === 'close_ticket' && args.ticketId !== supportCase.ticketId) {
      errors.push(`${at}: ticketId must be ${supportCase.ticketId}.`);
    }
  });

  const tools = plan.steps.map((s) => s?.tool);
  if (tools.includes('close_ticket') && !tools.includes('send_email')) {
    errors.push('Policy: the ticket cannot be closed unless the customer is emailed first.');
  }

  return { ok: errors.length === 0, errors };
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Deterministic, not model-written: built only from persisted runtime state.
export function handoffNote(run, actions) {
  if (run.status !== 'blocked') return null;
  const ticket = JSON.parse(run.case_json).ticketId;
  const lines = [`${ticket} needs a human.`];
  for (const a of actions) {
    const args = JSON.parse(a.args_json);
    const receipt = a.receipt_json ? JSON.parse(a.receipt_json) : null;
    if (a.status === 'confirmed') {
      const what = a.tool === 'issue_credit' ? `Credit ${formatCents(args.amountCents)}` : a.tool === 'send_email' ? 'Email' : 'Ticket closure';
      lines.push(`${what} confirmed (receipt ${receipt?.result?.creditId || receipt?.result?.messageId || receipt?.effectId}).`);
    } else if (a.status === 'blocked') {
      if (a.error_code === 'receipt_conflict') {
        lines.push(`${a.tool} returned a receipt that does not match the approved payload. Investigate before any retry.`);
      } else if (a.tool === 'send_email') {
        lines.push(`Email outcome unknown: the email tool cannot confirm delivery or deduplicate a retry. Check the outbox for "${args.subject}" before resending.`);
      } else {
        lines.push(`${a.tool} outcome unknown and the provider cannot prove it. Verify manually before retrying.`);
      }
    } else if (a.status === 'pending' && a.tool !== 'close_ticket') {
      lines.push(`${a.tool} not attempted.`);
    }
  }
  const closed = actions.some((a) => a.tool === 'close_ticket' && a.status === 'confirmed');
  if (!closed) lines.push('Ticket left open.');
  return lines.join(' ');
}
