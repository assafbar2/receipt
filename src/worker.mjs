import { isUuid } from './contracts.mjs';
import { openRuntime } from './store.mjs';
import { executeRun, httpTransport } from './runner.mjs';

const runId = process.argv[2];
if (!isUuid(runId)) {
  console.error('worker: invalid run id');
  process.exit(2);
}

const store = openRuntime(process.env.RECEIPT_RUNTIME_DB);
const transport = httpTransport(process.env.RECEIPT_PROVIDER_URL);

try {
  await executeRun({ store, transport, runId });
  store.close();
  process.exit(0);
} catch (err) {
  console.error(`worker ${process.pid}: ${err.message}`);
  store.close();
  process.exit(1);
}
