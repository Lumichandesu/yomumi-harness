import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agent-dispatch-mcp-'));
let handle: (msg: any) => Promise<any>;

beforeAll(async () => {
  // Point the server's dispatcher at a temporary vault before it is created (it is created lazily).
  const comms = join(dir, 'Agent-Comms');
  mkdirSync(join(comms, 'Tasks'), { recursive: true });
  writeFileSync(join(comms, 'README.md'), '# README\n');
  writeFileSync(join(comms, 'Board.md'), '# Board\n');
  process.env.AGENT_DISPATCH_COMMS_DIR = comms;
  process.env.AGENT_DISPATCH_RUNS_DIR = join(dir, 'runs');
  handle = (await import('../mcp-server')).handle;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('MCP server (stdio JSON-RPC)', () => {
  test('initialize negotiates a protocol version and advertises tools', async () => {
    const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities.tools).toBeTruthy();
    expect(r.result.serverInfo.name).toBe('agent-dispatch');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  test('tools/list exposes the operations', async () => {
    const r = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = r.result.tools.map((t: any) => t.name);
    for (const n of ['list_agents', 'preview_plan', 'dispatch_plan', 'dispatch_task', 'task_status', 'task_result', 'cancel_task', 'run_queue', 'list_tasks']) expect(names).toContain(n);
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  test('list_agents runs real detection without launching anything', async () => {
    const r = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} } });
    expect(r.result.content[0].text).toContain('| Agent | Installed | App open |');
  });

  test('dispatch_plan requires a preview first; bad input is a tool error, not a crash', async () => {
    const r = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dispatch_plan', arguments: {} } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('preview_plan');
    const bad = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dispatch_task', arguments: { prompt: 'x', cwd: dir, mode: 'read-only' } } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('owner_quote');
    const unknown = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    expect(unknown.error.code).toBe(-32602);
    expect((await handle({ jsonrpc: '2.0', id: 7, method: 'nope' })).error.code).toBe(-32601);
  });

  test('preview_plan returns the heavy/light table and a preview id (nothing dispatched)', async () => {
    const r = await handle({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'preview_plan', arguments: { owner_quote: 'test quote from the owner', tasks: [{ key: 'a', prompt: 'Find the config loader', cwd: dir, mode: 'read-only', kind: 'search' }] } },
    });
    const text = r.result.content[0].text;
    expect(text).toMatch(/preview_id: \d{6}-\d{6}-[0-9a-f]{4}/);
    expect(text).toContain('**light** (search)');
  });
});
