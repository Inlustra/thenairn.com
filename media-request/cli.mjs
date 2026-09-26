import { runRequest } from './request.mjs';
try { console.log(JSON.stringify(await runRequest(JSON.parse(process.argv[2] ?? '{}')))); }
catch (e) { console.log(JSON.stringify({ state: 'temporarily_unavailable', reason: e.publicCode ?? 'service_unavailable' })); process.exitCode = 1; }
