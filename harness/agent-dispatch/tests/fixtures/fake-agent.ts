/**
 * Fake agent CLI for tests. Prints Claude-shaped JSON.
 *   bun fake-agent.ts <behavior> <runDir>
 * behaviors: ok | quota | fail | sleep | tree | handoff | slow:<ms> | secret
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [behavior = 'ok', runDir = '.'] = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

const log = (s: string) => {
  try {
    appendFileSync(join(runDir, '..', '..', 'fake-agent.log'), `${s}\n`);
  } catch {}
};

if (behavior === 'ok') {
  out({ type: 'result', subtype: 'success', is_error: false, result: `Did the work.\nRESULT SUMMARY: fake done, prompt ${stdin.length} chars`, total_cost_usd: 0.001 });
} else if (behavior === 'quota') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached. Your limit will reset at 5pm.' });
  process.exit(1);
} else if (behavior === 'fail') {
  process.stderr.write('something broke\n');
  process.exit(3);
} else if (behavior === 'secret') {
  // A fake key, assembled at runtime so the source file holds no key-shaped literal.
  const fakeKey = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('-');
  out({ type: 'result', subtype: 'success', is_error: false, result: `Found key ${fakeKey} in a file.\nRESULT SUMMARY: leaked ${fakeKey}` });
} else if (behavior === 'handoff') {
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Part of this is a lookup.\nRESULT SUMMARY: handed the lookup off.\nHANDOFF\nto: auto\nweight: light\nmode: read-only\nrequest: Find where the README mentions Hermes.\nEND HANDOFF',
  });
} else if (behavior === 'sleep') {
  await Bun.sleep(60000);
} else if (behavior === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(join(runDir, 'pids.json'), JSON.stringify({ parent: process.pid, child: child.pid }));
  await Bun.sleep(60000);
} else if (behavior.startsWith('slow:')) {
  const ms = Number(behavior.slice(5));
  log(`start ${Date.now()}`);
  await Bun.sleep(ms);
  log(`end ${Date.now()}`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'RESULT SUMMARY: slow done' });
}
