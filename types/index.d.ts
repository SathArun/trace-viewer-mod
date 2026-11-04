export type ToolRow = {
  id: string
  name: string
  /** The input, compact and cut short. */
  input: string
  /** The output's first part, on one line; absent until the result arrives. */
  output?: string
  isError: boolean
  isTruncated: boolean
}

export type Turn = {
  n: number
  stop?: string
  tokens: number
  cost: number
  latencyMs: number
  tools: ToolRow[]
}

export type Timeline = {
  runId: string
  startedAt?: string
  task: string
  model?: string
  effort?: string
  maxTurns?: number
  isFinished: boolean
  status?: string
  answer?: string
  error?: string
  turns: Turn[]
  tokens: number
  cost: number
  wallMs?: number
}

export type RunSummary = {
  runId: string
  file: string
  mtimeMs: number
  startedAt?: string
  task: string
  isFinished: boolean
  status?: string
  turns: number
  tokens: number
  cost: number
}

/** `list`, or the run id whose timeline is shown. */
export type View = { kind: 'list' } | { kind: 'run'; runId: string }

declare module 'claude-code' {
  interface PluginState {
    'trace-viewer-mod': {
      runs: Shaped<RunSummary[]>
      view: Shaped<View>
      detail: Shaped<Timeline | null>
    }
  }
}
