# Changelog

All notable changes to Isar Flow are listed here.

## 0.2.0 (unreleased)

Trust and real-world use.

### Added

- **Review changes**: after a run that changed files, a notification (`<workflow> changed 3 files.` with
  **Review changes**) and a review card above the canvas list every changed file with its status, +/- lines
  and the block that changed it (**Command** for console commands). Select a file for a diff of before and
  now; **Keep** or **Revert** each file, or **Keep all** / **Revert all**. Reverts restore files byte for byte,
  recreate deleted files and delete added ones, and ask first when a file changed again after the run. Past
  runs keep their decisions (`3 kept, 1 reverted`, `2 to review`) in the Runs menu, the run history and the
  sidebar.
- **Run snapshots**: in a git repository, the workflow's folder is snapshotted before and after each run with a
  temporary index (`refs/isarflow/runs/<run>/before` and `…/after`); your index, branch, stash and working tree
  are never touched. Without git, an edit journal keeps the originals of files that agents write.
- **Worktree isolation**: `isolation: worktree` runs a workflow on its own git worktree, checked out at the
  before snapshot, with optional `setup:` commands (for example `npm ci`) that run first and are part of the
  command confirmation. **Keep** copies a change into the workspace; the worktree is removed once every file is
  decided. The workflow panel has a **Run in** switch and a list of setup commands. New example:
  `examples/worktree-fix.workflow.yaml`.
- **`applyPatch` tool** (Apply patches, edit permission): unified diffs over one or more files, including new
  and deleted files, with tolerant hunk matching near the stated line, all or nothing, and clear per-hunk
  errors. The Coder starter includes it.
- **Tool calls for local models**: agent setting `toolMode` (**Tool calls**: Automatic, Native, Text in the
  prompt). Automatic also runs tool calls a model writes as text (`<tool_call>` tags, fenced or plain JSON)
  and switches to text tool mode for models without native tool calling.
- **Conversation summaries**: when an agent's conversation grows above 70 % of the model's context
  (`maxInputTokens`, else the new setting `isarFlow.agentContextTokens`, default 24000), older turns are
  replaced by a summary from the same model. The run log notes each one.
- **Test model**: command **Isar Flow: Test model**, a beaker button on endpoints in the sidebar and **Test
  model** in the agent editor. One tool call and one JSON answer show whether tool calls work, the model needs
  text tool mode, or what to fix. Results are kept for 30 days and shown as chips in the model pickers.
- **Check setup**: command **Isar Flow: Check setup** and a sidebar button check every endpoint and test the
  models your workflows use, with a fix button per problem.
- **Time and tokens per block**: block cards show time, tokens and cost after a run; the inspector's run
  summary has a table per block (status, time, tokens, model, iterations) and averages over the last 20 runs;
  a block's run output adds turns, tool calls and its own averages. Agent blocks have a new output
  `toolCalls`.
- **Model prices**: setting `isarFlow.modelPrices` (per 1 million input and output tokens by model
  reference). Costs are shown only for listed models.
- **Capability badges**: **Read-only**, **Edits files (asks/auto)** and **Runs commands (asks/auto)** on agent
  rows, the agent editor header and agent cards. The Blank starter says that it is read-only, and the New
  agent card recommends Coder for agents that change code.

### Changed

- `editFile` matches tolerantly: exactly, then ignoring line-ending differences, then ignoring whitespace per
  line (indentation taken from the file). The match must still be unique, also in a file with mixed line
  endings.
- `editFile` and `applyPatch` no longer change files that are not UTF-8: their unreadable characters would have
  been replaced with `�`.
- When an agent changes a file that has unsaved changes in an editor, the write saves them; **Revert** now
  restores that unsaved text instead of the older file on disk.
- `steps.<id>.usage` of a retried block now adds up every attempt (it was the last attempt only), so block
  tokens add up to the run total. `toolCalls` adds up the same way, and failed agent blocks report the tool
  calls they made.
- `isarFlow.historyLimit` also removes the snapshots, review data and worktrees of runs dropped from the
  history.
- Integration tests start VS Code with `--disable-gpu`.

## 0.1.0

First release.

- **Sidebar**: an **Agents** tab with your agents and model endpoints (status, model count, API key, remove),
  and a **Workflows** tab with every workflow in the workspace, run and stop buttons, and recent runs. New
  agents start blank or as a coder or reviewer; new workflows start blank or from the **Review loop** or
  **Test and fix** template.
- **River editor** for `*.workflow.yaml`: blocks on a vertical stream with lanes for If / else and a return
  channel for loops. Add blocks from the palette or the **+** between blocks, drag and drop them, move them
  with **Move to…** or Alt+↑/↓, duplicate and delete them from the keyboard, and zoom. The inspector edits
  every field, with an insert-variable picker and a condition builder (rules or expression). Canvas and YAML
  stay in sync in both directions; visual edits keep comments and formatting, and unreadable YAML keeps the
  last good canvas with a pointer to the broken line.
- **Blocks**: Agent, Console, Loop (until, while or a fixed count, `maxIterations` required), If / else,
  Break, Stop and Approval. Every block supports `timeout`, `retry` and `continueOnError`.
- **Expressions**: `${{ … }}` templates with inputs, block outputs, environment, loop variables and
  secrets, 17 functions, and structured conditions with 16 operators.
- **Agents**: `*.agent.yaml` files in the workspace (`.isarflow/agents/`) or for your user, edited in a form
  with **Try it** chat. Model and fallback models, system prompt, temperature, token and turn limits, seven
  built-in tools and `none` / `ask` / `auto` permissions for edits and commands (unset means `ask`).
  JSON answers with compact shapes or JSON Schema and one repair round. Context files attached by glob.
- **Models**: the language models VS Code offers (for example GitHub Copilot) and any OpenAI-compatible
  endpoint (LiteLLM, Ollama, vLLM, OpenRouter, OpenAI …) with presets, model discovery, a manual model list,
  extra headers, retries and fallback models. API keys are kept in VS Code's secret storage.
- **Runs**: from the canvas, the sidebar, a CodeLens, the Explorer or the Command Palette. Inputs dialog,
  live block status and loop iterations, rendered prompts, outputs and tool calls in the inspector, console
  output mirrored to a terminal, inline approvals, a status bar item, **Stop** that ends the processes a run
  started, and a history of recent runs per workflow.
- **Safety**: runs need a trusted workspace; console commands, their shell, folder and environment are
  confirmed per workflow version; agent tools stay inside the workflow's folder (links, junctions and short
  names resolved, `.git` read-only); workspace endpoints are ignored in Restricted Mode; an optional token
  budget stops expensive runs; secrets are masked in run output, the terminal and the history.
- **Multi-root workspaces**: new workflows and workspace agents go to the folder you pick; runs, agent tools
  and context files use the workflow's own folder.
- JSON Schemas for workflow and agent files, so the Red Hat YAML extension offers completion and validation.
