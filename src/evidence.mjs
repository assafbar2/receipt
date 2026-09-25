import { readFileSync } from 'node:fs';

const MAX_EXCERPT = 2000;

export function cachedEvidence() {
  const e = JSON.parse(readFileSync(new URL('../fixtures/evidence.json', import.meta.url), 'utf8'));
  return { ...e, source: 'cached' };
}

export function excerptFrom(markdown) {
  const text = String(markdown || '');
  const i = text.search(/^#+\s*Resolved\b/m);
  return (i >= 0 ? text.slice(i) : text).slice(0, MAX_EXCERPT).trim();
}

// Nimble Extract: POST {base}/v2/extract. Web content is untrusted data for the planner only.
export async function fetchEvidence({ config, fetchImpl = fetch }) {
  if (!config.nimbleApiKey || !config.statusPageUrl) {
    return { ...cachedEvidence(), note: 'Nimble not configured; using cached evidence' };
  }
  const call = async (render) => {
    const res = await fetchImpl(`${config.nimbleBaseUrl}/v2/extract`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.nimbleApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: config.statusPageUrl, formats: ['markdown'], ...(render ? { render: true } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'success') throw new Error(`Nimble ${res.status} ${data.status || ''}`.trim());
    return data;
  };
  try {
    let data = await call(false);
    if (!data?.data?.markdown) data = await call(true);
    const excerpt = excerptFrom(data?.data?.markdown);
    if (!excerpt) throw new Error('Nimble returned no markdown');
    return {
      source: 'nimble',
      url: config.statusPageUrl,
      fetchedAt: new Date().toISOString(),
      taskId: data.task_id || '',
      excerpt,
    };
  } catch (err) {
    return { ...cachedEvidence(), note: `Live Nimble fetch failed (${err.message}); using cached evidence` };
  }
}
