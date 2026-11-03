# Changelog

All notable changes to Isar Flow are listed here.

## 0.2.0 (unreleased)

Trust and real-world use, and faster building of workflows.

### Added

- **Run from here**: continue a finished, failed or cancelled run at a block from the block's context menu,
  its **Run output**, **Run from <block>** under failed and cancelled runs in the **Runs** menu, or **Run from
  here** in the YAML context menu and the Command Palette (the block under the cursor). Blocks before it reuse
  their results from that run (marked **Reused**, no time or tokens); a loop around the block continues at the
  iteration where it last ran and an If takes the block's branch. The dialog fills in that run's inputs and
  warns about blocks that changed since (each block's YAML is hashed with the run), missing, shortened or
  masked results, loops past a lowered limit, forced branches, agents that start a new conversation,
  worktrees and reverted files. Resumed runs are marked **Resumed** (with "Resumed from <block>") in the
  history, the sidebar and on the Start marker.
- **Live values**: runs save the names (never the values) of environment variables and secrets with their
  inputs and outputs, so hovering a `${{ … }}` template on a block card, under a field in the inspector
  (**Values from the last run**, with **Copy**) or in the YAML editor shows what it evaluated to in the last
  run. If and Loop headers and the condition builder show **Last run: true/false**. Values are cut at 2 KB and
  secrets show as `••••••`.
- **Test mode**: **Simulate** in the new menu next to **Run** (also a CodeLens, the Explorer menu, Alt-click
  on the editor title's Run button and **Isar Flow: Simulate workflow**) runs a workflow with mocks from
  `.isarflow/simulations/<workflow file name>.sim.yaml`: no commands, no model calls, no file changes, no
  command confirmation, approvals answered automatically. Each call takes the next result of its block; blocks
  without mocks get defaults (exit 0, `(simulated answer)`, sample JSON from the block's JSON fields,
  approved). The inspector's **Simulation** section edits a block's mocks and keeps the file's comments;
  renaming a block moves its mocks. The editor warns about unknown blocks, wrong fields and JSON that doesn't
  fit; the YAML extension validates the file with the new `simulation.schema.json`. Simulated runs are marked
  **Simulated**, use no tokens, are left out of the averages and also work in Restricted Mode (without
  secrets). Command **Isar Flow: Open simulation file**; new example
  `examples/.isarflow/simulations/review-loop.sim.yaml`.

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
  history. Simulated runs are counted separately, so simulating never pushes a real run and its review out of
  the history.
- The **Run** button of the workflow editor is a split button with **Run**, **Simulate** and **Edit
  simulation mocks**. In Restricted Mode the canvas banner says that workflows can still be simulated.
- The history keeps where a run stopped, its start time and loop iterations even when it trims a large run, and
  marks results it shortened, so Run from here can warn about them.
- **Run from here** from the YAML context menu or the Command Palette shows the same warnings as the canvas
  dialog (changed, missing, shortened or masked results, …) and asks before it starts.
- A run continued with Run from here keeps the YAML hash of each block it reused from the earlier run, so
  continuing it again still warns about blocks changed since then. Blocks after the start block inside a
  continued loop show their previous round's result (marked **Reused**) until they run, and keep it for the
  next Run from here.
- **Simulate** on the canvas simulates the workflow as it is, unsaved edits included, without saving the file.
- Simulation files explain unknown keys: a block id at the top level is told to go under `blocks:`, and a
  mistyped result field names the field that was meant (for `exitcode` it suggests `exitCode`).
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
