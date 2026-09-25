import { capabilities, payloadHash } from './contracts.mjs';

// HTTP transport to the provider. Never touches the provider database.
export function httpTransport(baseUrl, { timeoutMs = 10_000 } = {}) {
  return {
    async dispatch(tool, body) {
      let res;
      try {
        res = await fetch(`${baseUrl}/tools/${tool}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { kind: 'uncertain', error: `No response: ${err.cause?.code || err.name}` };
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { kind: 'ok', receipt: data.receipt };
      if (res.status === 409) return { kind: 'conflict', error: data.error || 'conflict' };
      if (res.status >= 500) return { kind: 'uncertain', error: `Provider error ${res.status}` };
      return { kind: 'rejected', error: data.error || `HTTP ${res.status}` };
    },
    async lookup(tool, operationKey) {
      try {
        const res = await fetch(`${baseUrl}/tools/receipts/${tool}/${encodeURIComponent(operationKey)}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
        return await res.json();
      } catch (err) {
        return { status: 'error', error: err.cause?.code || err.name };
      }
    },
  };
}

const receiptMatches = (receipt, action) =>
  receipt && receipt.tool === action.tool && receipt.operationKey === action.operation_key && receipt.payloadHash === action.payload_hash;

async function dispatchAndRecord(store, transport, run, action) {
  const current = store.markInFlight(action, run.policy);
  const args = JSON.parse(current.args_json);
  if (payloadHash(current.tool, args) !== current.payload_hash) {
    store.fail(current, 'payload_hash_mismatch', 'Persisted args no longer match the approved payload hash');
    return 'stop';
  }
  const out = await transport.dispatch(current.tool, {
    runId: run.run_id,
    actionId: current.action_id,
    operationKey: current.operation_key,
    payloadHash: current.payload_hash,
    args,
  });
  if (out.kind === 'ok') {
    if (!receiptMatches(out.receipt, current)) {
      store.block(current, 'receipt_conflict', 'Provider receipt does not match tool, key, or payload');
      return 'stop';
    }
    store.confirm(current, out.receipt, 'action.confirmed', `Provider receipt ${out.receipt.effectId.slice(0, 8)} matched`);
    return 'next';
  }
  if (out.kind === 'conflict') {
    store.block(current, 'receipt_conflict', `Provider rejected the key: ${out.error}`);
    return 'stop';
  }
  if (out.kind === 'rejected') {
    store.fail(current, 'rejected', `Provider rejected before mutation: ${out.error}`);
    return 'stop';
  }
  store.markUncertainAndInterrupt(current, `${out.error}; outcome unknown`);
  return 'stop';
}

// RECEIPT policy: reconcile before anything downstream runs; block without proof.
async function recoverReceipt(store, transport, run, action) {
  const caps = capabilities(run.provider_profile, action.tool);
  if (caps.lookup) {
    const found = await transport.lookup(action.tool, action.operation_key);
    if (found.status === 'found') {
      if (!receiptMatches(found.receipt, action)) {
        store.block(action, 'receipt_conflict', 'Stored receipt does not match the approved payload');
        return 'stop';
      }
      store.confirm(action, found.receipt, 'action.reconciled', 'Matched provider receipt after worker interruption; not re-sent');
      return 'next';
    }
    if (found.status === 'error') {
      store.interrupt(run.run_id, action, `Receipt lookup failed (${found.error}); action stays uncertain`);
      return 'stop';
    }
    // not_found or unsupported: fall through to the idempotency rule.
  }
  if (!caps.idempotent) {
    store.block(action, 'unprovable', `${action.tool} provider offers no receipt lookup and no idempotent retry`);
    return 'stop';
  }
  return dispatchAndRecord(store, transport, run, action);
}

// Naive "retry on error" policy: re-sends unknown outcomes as new requests.
async function recoverNaive(store, transport, run, action) {
  return dispatchAndRecord(store, transport, run, action);
}

export async function executeRun({ store, transport, runId }) {
  const run = store.getRun(runId);
  if (!run || run.status !== 'running') throw new Error(`Run ${runId} is not running`);
  const recover = run.policy === 'naive' ? recoverNaive : recoverReceipt;

  for (const action of store.getActions(runId)) {
    if (action.status === 'confirmed') continue;
    if (action.status === 'blocked' || action.status === 'failed') return;
    let step;
    if (action.status === 'uncertain' || action.status === 'in_flight') {
      step = await recover(store, transport, run, action);
    } else {
      step = await dispatchAndRecord(store, transport, run, action);
    }
    if (step === 'stop') return;
  }
  store.complete(runId);
}
