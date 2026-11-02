# Isar Flow — Packages A, B, C (design)

Date: 2026-11-02 · Status: approved by the owner in chat ("Yes that sounds good"), with one exclusion:
**no MCP server** for Claude Code or other external agents. Builds on the v1 spec
(`2026-10-25-isar-flow-design.md`); everything there still applies unless changed here.

Isar Flow runs workflows **locally**. These packages make runs trustworthy (A), workflows faster to build (B)
and workflows part of everyday work (C).

## Package A — Trust and real-world use

### A1 Safety net (snapshots, edit journal, review card)

- **Run snapshot.** At run start the run manager snapshots the workflow's workspace folder.
  - Git repository: snapshot tracked and untracked, non-ignored files with a *temporary index*
    (`GIT_INDEX_FILE=<tmp> git add -A && git write-tree && git commit-tree`). The user's index, branch, stash
    and working tree are never touched. The commit is stored as `refs/isarflow/runs/<runId>/before`; at run end
    the same produces `…/after`. Changed files = diff of the two trees (added / modified / deleted, +/- lines).
  - No git: only files written by agent tools are covered (from the edit journal, which keeps the original
    content). The review card says that console-command changes are not covered without git.
- **Edit journal.** The tool host records every agent write: file, step id, original content (first write
  per file per run), time. Stored with the run (size-capped; large originals stored as git blobs when available).
- **Review card.** After a run that changed files, the workflow editor shows a review card (and a notification
  "N files changed — Review changes"):
  - List of changed files with status, +/- counts and which block changed them (journal; otherwise "command").
  - Click a file → VS Code diff editor (before = snapshot via a read-only `isarflow-snapshot:` content provider).
  - Per file **Keep** / **Revert**; **Revert all**; **Keep all**. Revert restores the before state (recreate
    deleted files, delete added files). If a file changed again after the run, ask before overwriting.
  - Past runs keep their review state in history ("3 kept, 1 reverted").
- **Isolation option.** Workflow key `isolation: workspace | worktree` (default `workspace`).
  - `worktree` (git only): the run executes in `git worktree add <extension storage>/worktrees/<runId>` checked
    out at the *before* snapshot (so uncommitted work is included); optional workflow key `setup:` (list of
    commands, e.g. `npm ci`) runs first. Console cwd, agent tools and context files are rooted there. The review
    card applies kept files back into the real workspace; the worktree is removed afterwards.
- Snapshot refs and worktrees are pruned together with run history (`isarFlow.historyLimit`).

### A2 Better with local models

- **`applyPatch` tool** (edit risk): unified diff, one or more files, tolerant hunk matching (whitespace and line
  ending differences ignored; hunks searched near the stated position). Clear per-hunk errors.
- **Tolerant `editFile`:** exact match → line-ending-normalized → whitespace-insensitive per line (indentation
  preserved from the file). The match must be unique; the result says which mode matched.
- **Context compaction:** when the estimated conversation size (chars/4) exceeds 70 % of the model's
  `maxInputTokens` (fallback setting `isarFlow.agentContextTokens`, default 24000), the oldest turns are replaced
  by a summary written by the same model; the system prompt, the task and the latest tool results stay verbatim.
  Logged as an info line.
- **Tool-call repair:** when a model answers without native tool calls but its text contains one (JSON with
  `name`/`arguments` or `tool`/`args`, `<tool_call>…</tool_call>`, fenced JSON), it is parsed and executed as
  a tool call. Malformed arguments get one corrective message. Agent setting `toolMode: auto | native | text`
  (default `auto`; `text` describes the tools in the prompt for models without native tool calling).
- **Test model:** command + buttons (agent editor model section, sidebar provider row) run a probe: one tool
  call, one JSON answer, latency. Result: "Tool calls work", "Needs text tool mode", or the failure. Cached per
  model and shown as a chip in the model picker.

### A3 Time and tokens per block

- Step outputs and run views carry `durationMs`, `usage` (input/output tokens), `model`, `turns`, `toolCalls`.
- Run summary table (block, status, time, tokens, model, iterations) in the inspector; the canvas card shows
  time and tokens after a run.
- Trends: average duration/tokens per block and average loop iterations over the last 20 runs (inspector).
- Optional setting `isarFlow.modelPrices` (`{ "<model ref>": { "input": <per 1M>, "output": <per 1M> } }`);
  costs are shown only when prices are set.

### A4 Capability clarity

- Agent rows (sidebar), the agent editor header and agent block cards show badges: **Read-only**,
  **Edits files**, **Runs commands** (with the permission level).
- The Blank starter explains: "Read-only: it can look at files but not change them. Turn on Edit files to let it
  change code." The New agent card recommends the Coder starter for agents that should change code.

### A5 Setup check

- Command **Isar Flow: Check setup** (and a sidebar button): checks each endpoint (reachable, key, models) and
  probes the models used by workflows (A2 Test model), then shows a report with fixes. The real-world test with
  the owner's LiteLLM uses this once the owner provides an endpoint.

## Package B — Build faster

### B1 Run from here

- On a block of a finished or past run: **Run from here** (card context menu, inspector Run output, Runs menu).
- Engine option `resume: { stepId, from: RunView/outputs, inputs }`: blocks before the target (document order)
  are not executed; their stored outputs seed `steps.*`. Containers on the path to the target are entered without
  re-evaluating what led there: a loop continues at the stored iteration of that loop, an if takes the branch that
  contains the target. After the target everything runs normally.
- Inputs are reused (editable in the inputs dialog). If blocks before the target changed since that run
  (hash of their YAML), the dialog warns. A resumed run is marked "Resumed from <block>" in history.

### B2 Live values

- Run history stores the expression context snapshot (inputs, step outputs, env names without values, secrets
  masked).
- Canvas/inspector: hovering a `${{ … }}` template shows its value from the last run; condition summaries show
  "Last run: true/false".
- YAML text editor: a HoverProvider for `*.workflow.y(a)ml` shows the same values for templates under the cursor.
- Values are truncated (2 KB) and secrets masked.

### B3 Test mode (simulation)

- Split Run button: **Run** / **Simulate**. A simulated run uses a simulation host: no commands, no model calls,
  no file changes, approvals and asks answered automatically (configurable).
- Mocks per block in `.isarflow/simulations/<workflow file name>.sim.yaml`: a list of results per block id used
  in order (the last repeats), e.g. `tests: [{ exitCode: 1, output: "1 failed" }, { exitCode: 0 }]`,
  `review: [{ json: { approved: false, issues: [x] } }, { json: { approved: true, issues: [] } }]`.
  Defaults: console exit 0 with empty output; agent text "(simulated answer)" or JSON built from the block's
  output shape.
- Inspector "Simulation" section edits the mock list of the selected block (writes the .sim.yaml).
- Simulated runs are marked "Simulated" in history and on the canvas.

## Package C — Everyday use

### C1 Workflows on code

- New expression roots captured at run start: `editor` (`selection`, `file` workspace-relative, `language`,
  `line`) and `git` (`branch`, `changedFiles` list, `diff` capped at 100 KB). Validation knows them; the variable
  picker lists them.
- Command **Run workflow on selection** (editor context menu when text is selected, command palette): QuickPick
  of workflows (those that use `editor.*` first), then run.

### C2 Triggers

- Workflow key `on:` with any of `save: { files: <glob or list> }`, `change: { files: <glob or list> }`,
  `schedule: { every: "15m" | "1h" | … }`. Triggers fire while VS Code is open, only in trusted workspaces and
  only for workflows whose confirmation hash is already approved (otherwise a notification asks to run it once
  manually). Debounce 2 s; skipped while the same workflow runs. Setting `isarFlow.triggers.enabled` (default
  true); a status bar item shows active triggers; the canvas Start marker shows them.

### C3 Copilot integration (no MCP)

- Language model tools (`contributes.languageModelTools`): `isarflow_listWorkflows` and `isarflow_runWorkflow`
  (workflow path or name + inputs). Only workflows with `expose: true` can be run; the normal confirmation applies
  (tool invocation confirmation + command confirmation). The tool result is the run summary and final outputs.
- Chat participant `@isarflow` with `/list`, `/run <workflow> [inputs]`, `/status`.

### C4 Notifications

- When the workflow editor is not visible: approvals and ask questions arrive as notifications with action
  buttons; finished runs notify with "Review changes" (when files changed) and "Open run".

### C5 Ask block

- `type: ask` with `question`, optional `choices` (list) and `default`; output `answer`. Shown as an inline card
  on the canvas (like approvals) or as a QuickPick/InputBox notification fallback. Timeout follows the common
  block `timeout`.

### C6 Project memory

- `.isarflow/memory.md` per workspace folder. Agent setting `memory: none | read | write` (default `read`):
  `read` adds the file (capped 8 KB) to the system prompt; `write` additionally gives the tool `remember(note)`
  which appends a dated bullet. Editable in the agent editor; the sidebar links the file.

### C7 Run report

- **Export report** (run summary, Runs menu): Markdown with timeline, statuses, durations/tokens, changed files
  (diffstat), agent answers and errors; **Copy for PR description** gives a short version.

### C8 Command line runner (no MCP mode)

- New package `packages/cli`, binary `isar-flow`: `isar-flow run <file> [--input k=v]… [--simulate] [--json]
  [--yes]`. Uses core + a Node host (console runner shared with the extension, OpenAI-compatible providers from
  `.isarflow/config.yaml` or environment variables). VS Code models are not available outside VS Code. Approvals
  and asks prompt in the terminal unless `--yes`. Exit code 0 = success, 1 = failure, 130 = cancelled.

## Cross-cutting

- Test concept of the v1 spec §11 applies to every feature (unit, contract, component, integration,
  interactions, visual). Coverage gates stay (core ≥ 90 %, extension ≥ 70 %).
- Integration tests launch VS Code with `--disable-gpu` (the owner's laptop has a GPU driver that freezes).
- User guide, README, CHANGELOG and examples are updated per package.
- Out of scope: MCP server, AI workflow generation, model comparison, terminal recording, canvas version diff.
