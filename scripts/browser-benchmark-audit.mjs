import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { auditSession, EVIDENCE_VERSION } from './lib/browser-benchmark-evidence.mjs';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const output = arg('output');
const inputs = process.argv.slice(process.argv.indexOf('--runs') + 1);
if (!output || !process.argv.includes('--runs') || !inputs.length) throw Error('Pass --output <fresh.json> --runs <run.json> ...');
const runs = [];
for (const input of inputs) {
  const source = await readFile(input, 'utf8'), run = JSON.parse(source), sessions = [];
  for (const session of run.sessions ?? []) {
    let audit;
    try {
      const events = (await readFile(session.log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      audit = auditSession(session.task, events, session.answer);
    } catch (error) { audit = { status: 'unverified', checks: [{ name: 'transcript available', state: 'unverified', detail: String(error) }] }; }
    sessions.push({ task: session.task, repeat: session.repeat, legacyOk: session.ok, audit });
  }
  runs.push({ tool: run.tool, input, sourceHash: createHash('sha256').update(source).digest('hex'), startedAt: run.startedAt, finishedAt: run.finishedAt, buildHash: run.provenance?.binaryHash ?? null, total: sessions.length, legacyPassed: sessions.filter(s => s.legacyOk).length, verified: sessions.filter(s => s.audit.status === 'pass').length, failed: sessions.filter(s => s.audit.status === 'fail').length, unverified: sessions.filter(s => s.audit.status === 'unverified').length, sessions });
}
const validatorHash = createHash('sha256').update(await readFile(new URL('./lib/browser-benchmark-evidence.mjs', import.meta.url))).digest('hex');
await writeFile(output, JSON.stringify({ version: EVIDENCE_VERSION, validatorHash, auditedAt: new Date().toISOString(), note: 'Historical reports and transcripts were not modified. Unverified is not a demonstrated task failure. This auditor checks native Anbo tool evidence, not Playwright text snapshots.', runs }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(runs.map(({ tool, total, legacyPassed, verified, failed, unverified }) => ({ tool, total, legacyPassed, verified, failed, unverified }))));
