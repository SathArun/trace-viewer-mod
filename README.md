# trace-viewer-mod

A Claude Code mod that shows an agent's run traces in a pane beside the chat.

It reads `traces/*.jsonl` in the project: one JSON event per line, with the types `run_started`, `model_call`, `tool_call`, `tool_result` and `run_finished`. It shows them in two views.

- **Run list:** the 20 newest runs, each with its time, status, turns, tokens, cost and task. Use ↑↓ to select a run and Enter to open it.
- **Timeline:** one run, turn by turn. Each turn shows the model call (stop reason, tokens, cost, latency) and every tool call next to its result, matched by `tool_use_id`. Errors show in red, and output that was cut short is tagged `(truncated)`. The final answer or error comes last. Press `b` to go back to the list.

When Claude runs `agent.py`, `evals.run_evals` or `-m service` through Bash, the pane opens and follows the new run live. It re-reads the trace folder every 2 seconds and parses only files that changed.

Commands: `/traces` opens the list, and `/traces latest` opens the newest run.

The pane only displays traces in your terminal. It sends nothing anywhere and writes no files.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install trace-viewer-mod --marketplace SathArun/trace-viewer-mod
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install trace-viewer-mod --marketplace SathArun/trace-viewer-mod
```

In the desktop app, where `/plugin` does not run, click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace** with `SathArun/trace-viewer-mod`, then **Add plugin**.

## License

MIT. See [LICENSE](LICENSE).
