import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunSummary, Timeline, View } from '../types'
import {
  cut,
  fmtCost,
  fmtMs,
  fmtTokens,
  hhmm,
  isAgentRun,
  parseTrace,
  statusIcon,
  summarize,
} from './parse'

const PANE = 'trace-viewer-mod'
const TITLE = 'Traces'
const COLUMNS = 90
const TRACE_DIR = 'traces'
const LIST_SIZE = 20
const POLL_MS = 2_000

// Change a tag when that value's fields change.
const runs = atom({ plugin: 'trace-viewer-mod', key: 'runs' } as const, [] as RunSummary[], {
  shape: 'runs-1',
})
const view = atom({ plugin: 'trace-viewer-mod', key: 'view' } as const, { kind: 'list' } as View, {
  shape: 'view-1',
})
const detail = atom({ plugin: 'trace-viewer-mod', key: 'detail' } as const, null as Timeline | null, {
  shape: 'detail-1',
})

// The module's own: start over on a reload, which only costs a re-read.
const cache = new Map<string, { mtimeMs: number; timeline: Timeline }>()
/** Set when Claude starts an agent run: the pane jumps to the run it writes. */
let followSince: number | undefined
let isBusy = false

const traceDir = async ($: EngineInterface) =>
  `${(await $.session.cwd()).replace(/[\\/]+$/, '')}/${TRACE_DIR}`

const loadFile = async ($: EngineInterface, dir: string, file: string, mtimeMs: number) => {
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.timeline
  const text = await $.fs.read(`${dir}/${file}`).then(
    t => (typeof t === 'string' ? t : ''),
    () => '',
  )
  const timeline = parseTrace(text, file.replace(/\.jsonl$/, ''))
  cache.set(file, { mtimeMs, timeline })
  return timeline
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Re-reads the trace folder (only files that changed) and the shown run. */
const refresh = async ($: EngineInterface) => {
  if (isBusy) return
  isBusy = true
  try {
    const dir = await traceDir($)
    const entries = await $.fs.list(dir).catch(() => [])
    const files = entries
      .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, LIST_SIZE)

    const list: RunSummary[] = []
    for (const f of files) {
      list.push(summarize(await loadFile($, dir, f.name, f.mtimeMs), f.name, f.mtimeMs))
    }
    if (!same(await read($, runs), list)) await update($, runs, () => list)

    let shown = await read($, view)
    const newest = list[0]
    if (followSince !== undefined && newest && newest.mtimeMs >= followSince) {
      if (shown.kind !== 'run' || shown.runId !== newest.runId) {
        shown = { kind: 'run', runId: newest.runId }
        await update($, view, () => shown)
      }
    }

    let timeline: Timeline | null = null
    if (shown.kind === 'run') {
      const runId = shown.runId
      const entry = files.find(f => f.name === `${runId}.jsonl`)
      const stat = entry ?? (await $.fs.stat(`${dir}/${runId}.jsonl`).catch(() => undefined))
      if (stat) timeline = await loadFile($, dir, `${runId}.jsonl`, stat.mtimeMs)
    }
    if (!same(await read($, detail), timeline)) await update($, detail, () => timeline)
  } finally {
    isBusy = false
  }
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })

const show = async ($: EngineInterface, next: View) => {
  followSince = undefined
  await update($, view, () => next)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'traces',
      description: 'Show agent run traces (traces/*.jsonl) in a pane',
      argumentHint: '[latest]',
    })
    $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))
    return ran
  })

  on('command.run', { command: 'traces' }, async ($, e) => {
    const wantsLatest = /^\s*latest\b/i.test(e.args)
    await refresh($)
    const list = await read($, runs)
    if (wantsLatest && list[0]) await show($, { kind: 'run', runId: list[0].runId })
    else if (!wantsLatest) await show($, { kind: 'list' })
    await open($)
    if (list.length === 0) return { text: `No traces in ${TRACE_DIR}/ yet.` }
    return { text: wantsLatest ? 'Showing the latest run.' : 'Traces pane opened.' }
  })

  // An agent run started by Claude: open the pane and follow its trace.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    if (typeof command !== 'string' || !isAgentRun(command)) return next(e)
    try {
      followSince = (await $.clock.now()) - 1_000
      void open($)
    } catch {
      // Never hold up the call over the pane.
    }
    const ran = await next(e)
    await refresh($).catch(() => undefined)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props?.bodyColumns ?? 80
    const shown = await read($, view)

    if (shown.kind === 'list') {
      const list = await read($, runs)
      if (list.length === 0) {
        return (
          <Box flexDirection="column">
            <Text dimColor>No traces in {TRACE_DIR}/ yet. Run the agent to make one.</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Text dimColor>
            {list.length} runs, newest first · ↑↓ select · Enter open
          </Text>
          {list.map(r => {
            const head = `${hhmm(r.startedAt)}  ${statusIcon(r.status, r.isFinished)} ${(r.isFinished ? r.status ?? '?' : 'running').padEnd(10)} ${String(r.turns).padStart(2)} turns ${fmtTokens(r.tokens).padStart(7)} tok  ${fmtCost(r.cost)}  `
            return (
              <Button
                key={r.runId}
                plain
                onPress={() => void show($, { kind: 'run', runId: r.runId })}
              >
                {head}
                <Text dimColor>{cut(r.task || r.runId, Math.max(10, cols - head.length - 2))}</Text>
              </Button>
            )
          })}
        </Box>
      )
    }

    const t = await read($, detail)
    const back = (
      <Button key="back" hotkey="b" plain onPress={() => void show($, { kind: 'list' })}>
        Back to runs
      </Button>
    )
    if (!t) {
      return (
        <Box flexDirection="column">
          {back}
          <Text dimColor>Loading run {shown.runId.slice(0, 8)}…</Text>
        </Box>
      )
    }

    const turnsLabel = t.maxTurns ? `${t.turns.length}/${t.maxTurns} turns` : `${t.turns.length} turns`
    const statusLabel = t.isFinished ? t.status ?? '?' : 'running…'
    const facts = [
      t.model,
      t.effort,
      `${statusIcon(t.status, t.isFinished)} ${statusLabel}`,
      turnsLabel,
      `${fmtTokens(t.tokens)} tok`,
      fmtCost(t.cost),
      t.wallMs ? fmtMs(t.wallMs) : undefined,
    ].filter(Boolean)
    const toolWidth = Math.max(20, Math.floor((cols - 8) * 0.55))
    const outWidth = Math.max(10, cols - 8 - toolWidth - 3)
    const isOk = t.isFinished && t.status === 'completed'

    return (
      <Box flexDirection="column">
        {back}
        <Text bold wrap="truncate-end">{t.task || t.runId}</Text>
        <Text dimColor wrap="truncate-end">
          {hhmm(t.startedAt)} · {facts.join(' · ')} · {t.runId.slice(0, 8)}
        </Text>
        <Text> </Text>
        {t.turns.map(turn => (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text bold>Turn {turn.n}</Text>
              {'  '}model → {(turn.stop ?? '…').padEnd(10)} {fmtTokens(turn.tokens).padStart(7)} tok  {fmtCost(turn.cost)}  {fmtMs(turn.latencyMs)}
            </Text>
            {turn.tools.map(tool => (
              <Text wrap="truncate-end">
                {'        '}
                <Text color={tool.isError ? 'error' : 'claude'}>
                  {tool.isError ? '✘ ' : ''}
                  {tool.name}
                </Text>{' '}
                <Text dimColor>{cut(tool.input, Math.max(4, toolWidth - tool.name.length))}</Text>
                {'  → '}
                {tool.output === undefined ? (
                  <Text dimColor>running…</Text>
                ) : (
                  <Text color={tool.isError ? 'error' : undefined}>
                    {cut(tool.output, outWidth)}
                    {tool.isTruncated ? ' (truncated)' : ''}
                  </Text>
                )}
              </Text>
            ))}
          </Box>
        ))}
        <Text> </Text>
        {t.error && (
          <Text color="error" wrap="wrap">
            Error  {t.error}
          </Text>
        )}
        {t.answer && (
          <Text wrap="wrap">
            <Text bold color={isOk ? 'success' : 'warning'}>Answer</Text>  {t.answer}
          </Text>
        )}
        {!t.isFinished && <Text dimColor>Run in progress, refreshing every {POLL_MS / 1000}s…</Text>}
      </Box>
    )
  })
}
