const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const short = (s, n = 8) => (s ? String(s).slice(0, n) : '');
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0') : '');

const FAULT_LABELS = {
  none: 'No fault',
  after_commit_issue_credit: 'Crash after the credit commits, before the agent hears back',
  after_commit_send_email: 'Crash after the email is sent, before the agent hears back',
  after_commit_close_ticket: 'Crash after the ticket closes, before the agent hears back',
};
const STATUS_TEXT = {
  pending: 'pending', in_flight: 'in flight', uncertain: 'uncertain', confirmed: 'confirmed', blocked: 'blocked', failed: 'failed',
};
const LANE_INFO = {
  receipt: { title: 'RECEIPT', desc: 'Stable operation keys. On resume, asks the provider for a receipt; stops when a tool cannot prove the outcome.' },
  naive: { title: 'Retry on error', desc: 'The common integration default: an unknown outcome is re-sent as a new request.' },
};

const state = { config: null, evidenceId: null, evidence: null, draft: null, run: null, poll: null };

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

// ---------- boot ----------

async function boot() {
  const { data } = await api('GET', '/api/config');
  state.config = data;
  const c = data.supportCase;
  $('goal').value = c.defaultGoal;
  $('case').innerHTML = `
    <div>
      <div class="label">Support case (synthetic)</div>
      <h2>${esc(c.ticketId)} · ${esc(c.customerName)}</h2>
      <dl>
        <dt>Account</dt><dd><code>${esc(c.accountId)}</code></dd>
        <dt>Recipient</dt><dd><code>${esc(c.recipient)}</code></dd>
        <dt>Policy max</dt><dd>${money(c.maxCreditCents)} ${esc(c.currency)}</dd>
        <dt>Ticket</dt><dd>open · no credits · no emails</dd>
      </dl>
    </div>
    <div>
      <div class="label">Customer message</div>
      <blockquote>${esc(c.customerMessage)}</blockquote>
      <div class="label" style="margin-top:8px">Policy</div>
      <div class="muted">${esc(c.policy)}</div>
    </div>`;

  const b = [];
  b.push('<span class="badge warn">Sandbox providers only</span>');
  b.push(data.plannerMode === 'live'
    ? `<span class="badge ${data.services.planner ? 'on' : 'off'}">Planner: Liquid AI · ${esc(data.plannerModel)} via OpenRouter</span>`
    : '<span class="badge warn">Fixture planner, not a live model</span>');
  b.push(`<span class="badge ${data.services.nimble ? 'on' : 'warn'}">Nimble ${data.services.nimble ? 'live' : 'not configured (cached)'}</span>`);
  b.push(`<span class="badge ${data.services.rawtree ? 'on' : 'off'}">Tinybird RawTree ${data.services.rawtree ? 'configured' : 'not configured'}</span>`);
  $('badges').innerHTML = b.join('');

  $('profile').innerHTML = Object.entries(data.profiles).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  $('fault').innerHTML = data.faults.map((f) => `<option value="${f}" ${f === 'after_commit_issue_credit' ? 'selected' : ''}>${esc(FAULT_LABELS[f] || f)}</option>`).join('');
  renderReadiness();
  $('profile').addEventListener('change', () => {
    if ($('profile').value === 'legacy_email' && $('fault').value === 'after_commit_issue_credit') $('fault').value = 'after_commit_send_email';
    renderReadiness();
  });
}

function renderReadiness() {
  const p = state.config.profiles[$('profile').value];
  $('readiness').innerHTML = `<div class="hint small">Tool readiness for agents</div>` + p.tools.map((t) =>
    `<div class="r"><code>${t.tool}</code><span class="grade ${t.grade}">${t.grade}</span></div>`).join('');
}

// ---------- step 1: evidence ----------

$('fetchEvidence').addEventListener('click', async () => {
  const btn = $('fetchEvidence');
  busy(btn, true, 'Fetching via Nimble…');
  $('evidence').innerHTML = '<p class="muted">Fetching the status page. This can take up to a minute.</p>';
  const { ok, data } = await api('POST', '/api/evidence', {});
  busy(btn, false);
  if (!ok) { $('evidence').innerHTML = `<div class="errors">Evidence unavailable: ${esc(data.error)}</div>`; return; }
  state.evidenceId = data.evidenceId;
  state.evidence = data.evidence;
  renderEvidence(data.evidence);
});

function renderEvidence(e) {
  if (!e) { $('evidence').innerHTML = '<p class="muted">No web evidence for this run.</p>'; return; }
  const live = e.source === 'nimble';
  $('evidence').innerHTML = `
    <div class="meta">
      <span class="badge ${live ? 'on' : 'warn'}">${live ? 'Live · Nimble Extract' : 'Cached evidence'}</span>
      <span class="muted small">${esc(new Date(e.fetchedAt).toLocaleString())}</span>
    </div>
    <div class="small"><a href="${esc(e.url)}" target="_blank" rel="noreferrer" style="color:var(--blue)">${esc(e.url)}</a></div>
    ${e.note ? `<p class="hint small">${esc(e.note)}</p>` : ''}
    <pre>${esc(e.excerpt)}</pre>`;
}

// ---------- step 2: plan ----------

$('useCreditOnly').addEventListener('click', () => { $('goal').value = state.config.supportCase.creditOnlyGoal; });
$('useDefault').addEventListener('click', () => { $('goal').value = state.config.supportCase.defaultGoal; });

function stepBody(s) {
  const a = s.args;
  if (s.tool === 'issue_credit') return `<b>${money(a.amountCents)} ${esc(a.currency)}</b> to <code>${esc(a.accountId)}</code>`;
  if (s.tool === 'send_email') return `To <code>${esc(a.recipient)}</code> · <b>${esc(a.subject)}</b><div class="body">${esc(a.body)}</div>`;
  return `Close ticket <code>${esc(a.ticketId)}</code>`;
}

$('generate').addEventListener('click', async () => {
  const btn = $('generate');
  busy(btn, true, state.config.plannerMode === 'live' ? 'Asking Liquid…' : 'Planning…');
  $('plan').innerHTML = '';
  $('approve').disabled = true;
  const { ok, data } = await api('POST', '/api/runs', { goal: $('goal').value, evidenceId: state.evidenceId });
  busy(btn, false);
  if (!ok) {
    state.draft = null;
    $('plan').innerHTML = `<div class="errors"><b>${esc(data.error)}</b>${data.errors ? `<ul>${data.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>
      ${data.raw ? `<details><summary>Raw model output</summary><pre>${esc(data.raw)}</pre></details>` : ''}`;
    $('approveHint').textContent = 'No valid plan. Nothing will execute.';
    return;
  }
  state.draft = data;
  renderPlan(data);
  $('approve').disabled = false;
  $('approveHint').textContent = 'Approval freezes this exact plan. Any change needs a new plan.';
});

function renderPlan(data) {
  const live = data.plannerMode === 'live';
  $('plan').innerHTML = `
    <div class="meta">
      <span class="badge ${live ? 'on' : 'warn'}">${live ? `Live · ${esc(data.plannerModel)}` : 'Fixture planner, not a live model'}</span>
      <span class="badge on">Validated</span>
      <span class="muted small mono">plan ${short(data.planHash, 12)}</span>
    </div>
    <p class="summary">${esc(data.plan.summary)}</p>
    ${data.plan.steps.length ? `<ol>${data.plan.steps.map((s, i) => `<li><span class="tool">${i + 1}. ${s.tool}</span><div>${stepBody(s)}</div></li>`).join('')}</ol>` : '<p class="muted">Zero steps: nothing to execute.</p>'}`;
}

// ---------- step 3: approve & run ----------

$('approve').addEventListener('click', async () => {
  if (!state.draft) return;
  const btn = $('approve');
  busy(btn, true, 'Starting…');
  const approved = await api('POST', `/api/runs/${state.draft.runId}/approve`, {
    planHash: state.draft.planHash, profile: $('profile').value, fault: $('fault').value, compare: $('compare').checked,
  });
  if (!approved.ok) { busy(btn, false); alert(approved.data.error); return; }
  const started = await api('POST', `/api/runs/${state.draft.runId}/start`, {});
  busy(btn, false);
  btn.disabled = true;
  if (!started.ok) { alert(started.data.error); return; }
  $('approveHint').textContent = 'Plan frozen and running. Generate a new plan for another run.';
  state.draft = null;
  showRun(started.data.run);
  startPolling(started.data.run.runId);
});

$('resume').addEventListener('click', async () => {
  const btn = $('resume');
  busy(btn, true, 'Starting fresh worker…');
  const { ok, data } = await api('POST', `/api/runs/${state.run.runId}/resume`, {});
  busy(btn, false);
  if (!ok) { alert(data.error); return; }
  showRun(data.run);
  startPolling(data.run.runId);
});

$('audit').addEventListener('click', async () => {
  const btn = $('audit');
  busy(btn, true, 'Exporting & querying…');
  const { ok, data } = await api('POST', `/api/runs/${state.run.runId}/audit`, {});
  busy(btn, false);
  renderAudit(ok ? data : { status: 'unavailable', reason: data.error });
});

function startPolling(runId) {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    const { ok, data } = await api('GET', `/api/runs/${runId}`);
    if (!ok) return;
    showRun(data);
    const settled = data.lanes.every((l) => !l.active && ['completed', 'interrupted', 'blocked', 'failed'].includes(l.status));
    if (settled) clearInterval(state.poll);
  }, 500);
}

// ---------- run view ----------

function showRun(run) {
  state.run = run;
  $('run').hidden = false;
  $('runId').textContent = run.runId;
  const resumable = run.lanes.some((l) => l.status === 'interrupted' && !l.active);
  $('resume').hidden = !resumable;
  $('audit').disabled = run.lanes.some((l) => l.active || l.status === 'running');
  $('lanes').innerHTML = run.lanes.map(renderLane).join('');
  const blocked = run.lanes.find((l) => l.policy === 'receipt' && l.handoff);
  $('handoff').innerHTML = blocked ? `<div class="notice handoff card"><h4>Handoff note for a human agent</h4><div>${esc(blocked.handoff)}</div></div>` : '';
  renderTimeline(run);
}

function renderLane(l) {
  const info = LANE_INFO[l.policy];
  const o = l.observer;
  const expected = Object.fromEntries(l.actions.map((a) => [a.tool, 1]));
  const countClass = (tool) => (o[tool] > 1 ? 'dup' : o[tool] === 1 && expected[tool] ? 'ok' : '');
  const workers = l.workers.map((w) => `<span class="worker ${w.alive ? 'alive' : w.signal ? 'dead' : 'done'}">pid ${w.pid} · ${w.alive ? 'running' : w.signal ? `killed (${esc(w.signal)})` : `exited ${esc(w.exitCode)}`}</span>`).join('<span class="muted">→</span>');
  const actions = l.actions.map((a) => `
    <div class="action">
      <div><code>${a.ordinal}. ${a.tool}</code></div>
      <span class="pill ${a.status}">${STATUS_TEXT[a.status] || a.status}</span>
      <div class="keys">key ${esc(a.operationKey)}${a.receipt ? ` · receipt ${esc(short(a.receipt.effectId))}` : ''}${a.dispatchIntents > 1 ? ` · sent ${a.dispatchIntents}×` : ''}</div>
    </div>`).join('') || '<div class="muted">No actions.</div>';
  const blockedEmail = l.status === 'blocked' && l.actions.some((a) => a.status === 'blocked' && a.tool === 'send_email' && a.errorCode === 'unprovable');
  return `
    <div class="card lane ${l.policy}">
      <div class="lane-head">
        <h3>${info.title}</h3>
        <span class="pill ${l.status}">${l.status}</span>
      </div>
      <p class="lane-desc">${info.desc}</p>
      <div class="workers">${workers || '<span class="muted">No worker yet</span>'}</div>
      <div class="split">
        <div class="panel">
          <h4>What the agent knows</h4>
          ${actions}
        </div>
        <div class="panel">
          <h4>What actually happened</h4>
          <div class="sub">Observer only. Not available to the worker.</div>
          <div class="counts">
            <div class="count ${countClass('issue_credit')}"><span>Credits${o.creditedCents ? ` · ${money(o.creditedCents)}` : ''}</span><b>${o.issue_credit}</b></div>
            <div class="count ${countClass('send_email')}"><span>Emails</span><b>${o.send_email}</b></div>
            <div class="count ${countClass('close_ticket')}"><span>Ticket ${o.close_ticket ? 'closed' : 'open'}</span><b>${o.close_ticket}</b></div>
          </div>
        </div>
      </div>
      ${blockedEmail ? `<div class="notice blocked"><h4>Stopped: cannot prove the email outcome</h4>The email outcome is unknown to the worker. This provider cannot prove the result or safely deduplicate a retry. Execution stopped; the ticket remains open.</div>` : ''}
    </div>`;
}

function renderTimeline(run) {
  const rows = run.lanes.flatMap((l) => l.events.map((e) => ({ ...e, policy: l.policy })))
    .sort((a, b) => a.at.localeCompare(b.at));
  $('timeline').innerHTML = rows.map((e) => {
    const cls = e.type === 'worker.exited' && !/SIGKILL/.test(e.detail) ? 'done' : e.type.split('.')[1];
    return `<li><span class="t">${time(e.at)}</span><span class="lane-tag ${e.policy}">${e.policy === 'receipt' ? 'RECEIPT' : 'retry'}</span><span class="type ${cls}">${esc(e.type)}</span><span>${esc(e.detail)}${e.tool ? ` <code class="muted">${e.tool}</code>` : ''}</span></li>`;
  }).join('');
  $('timeline').scrollTop = $('timeline').scrollHeight;
}

function renderAudit(r) {
  const badge = r.status === 'live' ? '<span class="badge on">Live · complete</span>'
    : r.status === 'pending' ? '<span class="badge warn">Sync pending</span>'
      : '<span class="badge off">Unavailable</span>';
  if (!r.lanes) {
    $('auditResult').innerHTML = `${badge}<p class="muted">${esc(r.reason)}</p>`;
    return;
  }
  const lanes = r.lanes.map((l) => {
    const eff = l.perAction.map((a) => `<code>${a.tool}</code> <span class="${a.physicalEffects > 1 ? 'bad' : 'good'}">${a.physicalEffects}</span>`).join('<br>') || '<span class="muted">none</span>';
    return `<tr>
      <td>${l.policy === 'receipt' ? 'RECEIPT' : 'Retry on error'}</td>
      <td>${l.interruptions}</td>
      <td>${l.reconciled}</td>
      <td>${eff}</td>
      <td class="${l.duplicates ? 'bad' : 'good'}">${l.duplicates ? 'YES' : 'no'}</td>
      <td>${esc(l.status)}${l.blockedTool ? ` (${esc(l.blockedTool)})` : ''}</td>
    </tr>`;
  }).join('');
  $('auditResult').innerHTML = `
    <div class="meta">${badge}<span class="muted small">${r.rows} rows from RawTree · ${r.expected} expected · ${esc(r.reason)}</span></div>
    <table class="audit">
      <thead><tr><th>Lane</th><th>Worker kills</th><th>Reconciled</th><th>Physical effects per action</th><th>Anything twice?</th><th>Status</th></tr></thead>
      <tbody>${lanes}</tbody>
    </table>
    <details><summary>Query sent to RawTree</summary><pre>${esc(r.sql)}</pre></details>`;
}

// Read-only deep link: /?run=<id> reopens a run; add &audit=1 to also show its audit.
async function openFromUrl() {
  const params = new URLSearchParams(location.search);
  const runId = params.get('run');
  if (!runId) return;
  const { ok, data } = await api('GET', `/api/runs/${encodeURIComponent(runId)}`);
  if (!ok) return;
  renderEvidence(data.evidence);
  $('goal').value = data.goal;
  renderPlan(data);
  const first = data.lanes[0];
  $('profile').value = first.profile;
  renderReadiness();
  $('approveHint').textContent = 'Plan frozen at approval.';
  showRun(data);
  if (data.lanes.some((l) => l.active)) startPolling(runId);
  if (params.get('audit')) {
    const r = await api('POST', `/api/runs/${runId}/audit`, {});
    renderAudit(r.ok ? r.data : { status: 'unavailable', reason: r.data.error });
  }
}

boot().then(openFromUrl);
