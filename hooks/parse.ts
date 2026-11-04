import type { RunSummary, Timeline, ToolRow, Turn } from '../types'

type Json = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
export const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)

/** `{"path": "."}` -> `{path: "."}`, cut to `max` characters. */
export const compactInput = (input: unknown, max = 80) => {
  if (input === null || typeof input !== 'object') return cut(JSON.stringify(input) ?? '', max)
  const parts = Object.entries(input as Json).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  return cut(`{${parts.join(', ')}}`, max)
}

const tokensOf = (usage: unknown) => {
  const u = (usage ?? {}) as Json
  return num(u.total) || num(u.input_tokens) + num(u.output_tokens)
}

/**
 * Builds a run's timeline from its JSONL text. Lines that are not JSON (a
 * run still writing its last line) are skipped.
 */
export const parseTrace = (text: string, fallbackId = ''): Timeline => {
  const t: Timeline = {
    runId: fallbackId,
    task: '',
    isFinished: false,
    turns: [],
    tokens: 0,
    cost: 0,
  }
  const turnOf = (n: number): Turn => {
    let turn = t.turns.find(x => x.n === n)
    if (!turn) {
      turn = { n, tokens: 0, cost: 0, latencyMs: 0, tools: [] }
      t.turns.push(turn)
      t.turns.sort((a, b) => a.n - b.n)
    }
    return turn
  }
  const tools = new Map<string, ToolRow>()

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let e: Json
    try {
      e = JSON.parse(line) as Json
    } catch {
      continue
    }
    if (typeof e !== 'object' || e === null) continue
    t.runId = str(e.run_id) ?? t.runId
    switch (e.type) {
      case 'run_started': {
        t.startedAt = str(e.ts)
        t.task = oneLine(str(e.task) ?? '')
        t.model = str(e.model)
        t.effort = str(e.effort)
        const budget = (e.budget ?? {}) as Json
        t.maxTurns = num(budget.max_turns) || undefined
        break
      }
      case 'model_call': {
        const turn = turnOf(num(e.turn))
        turn.stop = str(e.stop_reason)
        turn.tokens = tokensOf(e.usage)
        turn.cost = num(e.cost_usd)
        turn.latencyMs = num(e.latency_ms)
        break
      }
      case 'tool_call': {
        const id = str(e.tool_use_id) ?? `${e.seq}`
        const row: ToolRow = {
          id,
          name: str(e.name) ?? '?',
          input: compactInput(e.input),
          isError: false,
          isTruncated: false,
        }
        tools.set(id, row)
        turnOf(num(e.turn)).tools.push(row)
        break
      }
      case 'tool_result': {
        const id = str(e.tool_use_id) ?? ''
        let row = tools.get(id)
        if (!row) {
          row = { id, name: str(e.name) ?? '?', input: '', isError: false, isTruncated: false }
          tools.set(id, row)
          turnOf(num(e.turn)).tools.push(row)
        }
        const out = typeof e.output === 'string' ? e.output : JSON.stringify(e.output ?? '')
        row.output = cut(oneLine(out), 200)
        row.isError = e.is_error === true
        row.isTruncated = e.truncated === true
        break
      }
      case 'run_finished': {
        t.isFinished = true
        t.status = str(e.status)
        t.answer = str(e.text) ? oneLine(str(e.text)!) : undefined
        t.error = e.error == null ? undefined : oneLine(typeof e.error === 'string' ? e.error : JSON.stringify(e.error))
        t.tokens = tokensOf(e.usage)
        t.cost = num(e.cost_usd)
        t.wallMs = num(e.wall_ms) || undefined
        break
      }
    }
  }
  if (!t.isFinished) {
    t.tokens = t.turns.reduce((s, x) => s + x.tokens, 0)
    t.cost = t.turns.reduce((s, x) => s + x.cost, 0)
  }
  return t
}

export const summarize = (t: Timeline, file: string, mtimeMs: number): RunSummary => ({
  runId: t.runId || file.replace(/\.jsonl$/, ''),
  file,
  mtimeMs,
  startedAt: t.startedAt,
  task: t.task,
  isFinished: t.isFinished,
  status: t.status,
  turns: t.turns.length,
  tokens: t.tokens,
  cost: t.cost,
})

/** A Bash command that starts an agent run, which writes a trace. */
export const isAgentRun = (command: string) =>
  /\bagent\.py\b|\bevals\.run_evals\b|-m\s+evals\b|-m\s+service\b/.test(command)

export const hhmm = (iso?: string) => {
  if (!iso) return '--:--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export const statusIcon = (status: string | undefined, isFinished: boolean) =>
  !isFinished ? '◌' : status === 'completed' ? '✔' : '✘'

export const fmtTokens = (n: number) => n.toLocaleString('en-US')
export const fmtCost = (n: number) => `$${n.toFixed(4)}`
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
