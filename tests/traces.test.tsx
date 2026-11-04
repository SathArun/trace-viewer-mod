import { expect, test } from 'claude-code/testing'

import { isAgentRun, parseTrace } from '../hooks/parse'

const ev = (o: object) => JSON.stringify(o)
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, total: i + o })

// A made-up finished run: two tools in parallel in turn 1, one error.
const DONE = [
  ev({ run_id: 'aaaa1111', seq: 0, ts: '2026-01-05T10:00:00+00:00', type: 'run_started', task: 'How many widgets\nare in stock?', model: 'claude-sonnet-5-5', effort: 'medium', budget: { max_turns: 10 } }),
  ev({ run_id: 'aaaa1111', seq: 1, type: 'model_call', turn: 1, stop_reason: 'tool_use', usage: usage(500, 40), cost_usd: 0.002, latency_ms: 1500 }),
  ev({ run_id: 'aaaa1111', seq: 2, type: 'tool_call', turn: 1, tool_use_id: 't1', name: 'list_files', input: { path: '.' } }),
  ev({ run_id: 'aaaa1111', seq: 3, type: 'tool_call', turn: 1, tool_use_id: 't2', name: 'read_file', input: { path: 'missing.txt' } }),
  ev({ run_id: 'aaaa1111', seq: 4, type: 'tool_result', turn: 1, tool_use_id: 't2', name: 'read_file', output: 'not found', is_error: true, truncated: false }),
  ev({ run_id: 'aaaa1111', seq: 5, type: 'tool_result', turn: 1, tool_use_id: 't1', name: 'list_files', output: 'stock.txt\nnotes/', is_error: false, truncated: false }),
  ev({ run_id: 'aaaa1111', seq: 6, type: 'model_call', turn: 2, stop_reason: 'end_turn', usage: usage(700, 60), cost_usd: 0.003, latency_ms: 1200 }),
  ev({ run_id: 'aaaa1111', seq: 7, type: 'run_finished', status: 'completed', text: 'There are 42 widgets.', error: null, turns: 2, usage: usage(1200, 100), cost_usd: 0.005, wall_ms: 3100 }),
].join('\n')

// A made-up run still writing: its last line is cut off.
const RUNNING = [
  ev({ run_id: 'bbbb2222', seq: 0, ts: '2026-01-05T11:00:00+00:00', type: 'run_started', task: 'Summarise the report', model: 'claude-sonnet-5-5', effort: 'low', budget: { max_turns: 5 } }),
  ev({ run_id: 'bbbb2222', seq: 1, type: 'model_call', turn: 1, stop_reason: 'tool_use', usage: usage(300, 20), cost_usd: 0.001, latency_ms: 900 }),
  ev({ run_id: 'bbbb2222', seq: 2, type: 'tool_call', turn: 1, tool_use_id: 'u1', name: 'read_document', input: { path: 'report.pdf', page: 1 } }),
  '{"run_id": "bbbb2222", "seq": 3, "type": "tool_res',
].join('\n')

test('parses a finished run, pairing results to calls by id', async () => {
  const t = parseTrace(DONE)
  expect(t.task).toBe('How many widgets are in stock?')
  expect(t.isFinished).toBe(true)
  expect(t.turns.length).toBe(2)
  const [list, read] = t.turns[0]!.tools
  expect(list?.output).toBe('stock.txt notes/')
  expect(read?.isError).toBe(true)
  expect(t.tokens).toBe(1300)
  expect(t.answer).toBe('There are 42 widgets.')
})

test('a run still writing parses up to its cut-off line', async () => {
  const t = parseTrace(RUNNING)
  expect(t.isFinished).toBe(false)
  expect(t.turns[0]?.tools[0]?.output).toBe(undefined)
  expect(t.tokens).toBe(320)
})

test('spots agent runs in Bash commands', async () => {
  expect(isAgentRun('python agent.py "What is the total?"')).toBe(true)
  expect(isAgentRun('python -m evals.run_evals --target new')).toBe(true)
  expect(isAgentRun('python -m pytest -q')).toBe(false)
})

const PANE = {
  plugin: 'trace-viewer-mod',
  component: 'Pane',
  requestId: 'trace-viewer-mod',
  props: {
    title: 'Traces',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane lists runs and opens one', async ($, on) => {
  const files: Record<string, { text: string; mtimeMs: number }> = {
    'aaaa1111.jsonl': { text: DONE, mtimeMs: 1000 },
    'bbbb2222.jsonl': { text: RUNNING, mtimeMs: 2000 },
  }
  const rel = (p: string) => p.replace(/\\/g, '/').replace(/^C:\/proj\/traces\//, '')
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.list', () => ({
    value: Object.entries(files).map(([name, f]) => ({ name, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const f = files[rel((e as { path: string }).path)]
    if (!f) throw new Error('ENOENT')
    return { value: f.text }
  })
  on('fs.stat', (_, e) => {
    const f = files[rel((e as { path: string }).path)]
    if (!f) throw new Error('ENOENT')
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('command.register', () => ({ value: { command: 'traces' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'traces', args: '', origin: 'user' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Newest first: the running one leads.
    const rows = await ui.findAll({ type: 'Button' })
    expect(rows[0]?.text).toMatch(/running/)
    expect(rows[1]?.text).toMatch(/completed.*How many widgets/)

    await ui.press({ key: 'aaaa1111' })
    expect((await ui.find({ type: 'Text', text: /Turn 1/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /read_file.*not found/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Answer.*42 widgets/ })) !== undefined).toBe(true)

    await ui.press({ key: 'back' })
    expect((await ui.findAll({ type: 'Button' })).length).toBe(2)
    await ui.unmount()
  }
})
