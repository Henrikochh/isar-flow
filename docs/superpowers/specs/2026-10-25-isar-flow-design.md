# Isar Flow — Design Spec

Date: 2026-10-25 · Status: approved by owner ("take your recommendations, start implementing")

Isar Flow is a VS Code extension for configuring AI agents and composing them into
YAML-based workflows with a graphical, block-based editor. The YAML file and the
visual editor are two views of the same document and stay in sync in both directions.

## 1. Goals and success criteria

- Two areas in a sidebar: **Agents** (configure agents) and **Workflows** (list, create, run).
- Agents can use every model VS Code exposes (`vscode.lm`, e.g. Copilot) plus models from
  any OpenAI-compatible endpoint configured in Isar Flow (LiteLLM, Ollama, vLLM, OpenRouter …).
- Workflows are YAML files built from blocks: **Agent**, **Console**, **Loop**, **If/Else**,
  plus **Break**, **Stop** and **Approval** (human-in-the-loop).
- Visual edits rewrite the YAML (comments preserved); YAML edits update the canvas live.
- A "review until good" loop can be built visually, runs inside VS Code with live status,
  agents can read and edit files, and runs always terminate (`maxIterations` required).
- The UI is distinctive and polished while feeling native in every VS Code theme.

## 2. Decisions (owner accepted all recommendations)

| # | Topic | Decision |
|---|---|---|
| 1 | Audience | Personal + team via git now; Marketplace-ready structure |
| 3 | "Configured models" | VS Code Language Model API (`vscode.lm`) |
| 4 | Custom endpoints | Isar Flow's own provider config: base URL + API key (SecretStorage), auto-discovery via `GET /models`, manual model list fallback |
| 5 | Other editors | VS Code first; OpenAI-compatible path works anywhere |
| 6 | Agent capabilities | Built-in tools in v1 (read, list, search, edit, write, run command, git diff); MCP / VS Code tools later |
| 7 | Edit approval | Per-agent policy `none \| ask \| auto` for edits and for commands |
| 8 | Session across iterations | `session: fresh` default, `continue` opt-in |
| 9 | Agent storage | Workspace `.isarflow/agents/` and user-global; workspace wins on id clash |
| 10 | Visual style | Vertical nested blocks with automatic layout ("river") |
| 11 | Placement | Activity-bar container → sidebar webview with Agents/Workflows tabs; editing in editor area via custom editors |
| 12 | Conditions v1 | exit code, equals/compare, contains, regex, empty checks, JSON fields; LLM-judge in v2 |
| 13 | Extra blocks v1 | Break, Stop, Approval |
| 14 | Console | Captured output mirrored live into a pseudoterminal; default shell: `pwsh` → `powershell` on Windows, `$SHELL`/`bash` → `sh` elsewhere |
| 15 | "Generatable both sides" | Two-way canvas ⇄ YAML sync in v1; AI generation of workflows later |
| 16 | Triggers | Manual (canvas, CodeLens, command palette, sidebar); engine stays CLI-ready (no `vscode` import in core) |
| 17 | Safety | `maxIterations` required (default 5); optional token budget per run; console commands need one-time confirmation per workflow content hash; Workspace Trust required to run |
| 18 | Project | Name **Isar Flow**, folder `isar-flow`, npm workspaces, TypeScript, React + Vite, English UI |

## 3. Architecture

```
┌──────────────── Extension host (Node, packages/extension) ───────────────┐
│ activation · commands · SidebarViewProvider · WorkflowEditorProvider      │
│ AgentEditorProvider · ModelRegistry ─┬─ VsCodeLmProvider (vscode.lm)      │
│                                      └─ OpenAICompatProvider (core client)│
│ SecretStorage · ConsoleRunner (child_process + Pseudoterminal mirror)     │
│ ToolHost (workspace-bounded fs, WorkspaceEdit) · RunManager ──► core      │
└──────────────▲───────────── typed postMessage protocol ──────────────────┘
               ▼
┌──────────────── Webviews (packages/webview-ui, React + Vite) ────────────┐
│ sidebar · workflow canvas + inspector · agent editor · run view           │
└──────────────────────────────────────────────────────────────────────────┘
```

Packages:

- `packages/core` — isomorphic TypeScript, **no `vscode` import, no Node-only APIs** except in
  clearly separated modules that are not imported by the webview. Contains: schemas (Zod),
  YAML I/O, edit operations, expression language, conditions, validation, workflow engine,
  agent runtime, OpenAI-compatible client (uses `fetch`), protocol types.
- `packages/extension` — the VS Code extension (bundled with esbuild into `dist/extension.js`).
- `packages/webview-ui` — React app bundled with Vite into `packages/extension/media/webview`.

Workspace file conventions:

- `.isarflow/agents/<id>.agent.yaml` — agent definitions (id = file basename).
- `.isarflow/workflows/<name>.workflow.yaml` — workflows; any `*.workflow.yaml` anywhere opens in the canvas.
- User-global agents live in the extension's global storage (`agents/<id>.agent.yaml`).
- Implementation notes: `.yml` is accepted as well as `.yaml`. In multi-root workspaces the agents of all
  folders are merged (first folder wins on an id clash); new workflows and workspace agents go to a folder
  the user picks. Opening a missing agent from a block creates `<id>.agent.yaml` with exactly that id, in
  the workflow's folder.

## 4. Model layer

```ts
interface ChatModelInfo { ref: string; provider: string; id: string; name: string;
  family?: string; capabilities: { tools: boolean; jsonSchema: boolean }; maxInputTokens?: number }

interface ChatModel extends ChatModelInfo {
  chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<ChatStreamEvent>;
}
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string };
```

- Model reference string: `<providerId>/<modelId>`; split at the **first** `/` (model ids may contain `/`).
  VS Code models: `vscode/<vendor>/<id>` (e.g. `vscode/copilot/gpt-4.1`).
- Provider settings (`isarFlow.providers` in settings.json):
  `{ id, label, baseUrl, discoverModels: true, models?: string[], headers?: object }`.
  API keys: SecretStorage key `isarFlow.provider.<id>.apiKey`.
  Implementation notes: `isarFlow.vscodeModels` (default true) turns the `vscode.lm` provider off;
  `isarFlow.providers` is a restricted configuration, so in Restricted Mode only user endpoints are used.
- OpenAI-compatible client: `GET {baseUrl}/models`; `POST {baseUrl}/chat/completions` with
  `stream: true`, SSE parsing, tool calls (`tools`, `tool_choice: auto`), `response_format: json_schema`
  when the step requests JSON and the model supports it (otherwise instruct + validate + one repair retry).
- Errors 429/5xx/network are retried with exponential backoff (3 attempts); then `fallbackModels` are tried.

## 5. Agents

```yaml
# .isarflow/agents/reviewer.agent.yaml
name: Reviewer
description: Strict senior code reviewer
model: litellm/claude-sonnet
fallbackModels: [vscode/copilot/gpt-4.1]
systemPrompt: |
  You are a strict senior reviewer …
temperature: 0.2
maxTokens: 4000
maxTurns: 20
tools: [readFile, listFiles, searchText, gitDiff]
permissions: { edits: none, commands: none }   # none | ask | auto
```

Built-in tools (all paths resolved inside the workspace folder; anything outside is refused):

| Tool | Effect | Permission gate |
|---|---|---|
| `readFile(path, startLine?, endLine?)` | file text (truncated at 200 KB) | — |
| `listFiles(glob?)` | matching workspace paths (max 500) | — |
| `searchText(query, glob?, isRegex?)` | matches with path:line (max 200) | — |
| `gitDiff(staged?)` | `git diff` output | — |
| `editFile(path, oldText, newText)` | exact single-occurrence replace via `WorkspaceEdit` (undoable) | `edits` |
| `writeFile(path, content)` | create/overwrite via `WorkspaceEdit` | `edits` |
| `runCommand(command, cwd?)` | console runner, 120 s default timeout | `commands` |

`ask` shows a VS Code modal (Allow / Allow for this run / Deny). Denials are returned to the model as tool errors.
Implementation notes: an unset permission means `ask`; the agent editor's Try it treats `auto` as `ask`;
edits are saved right away so later console blocks see them; nothing inside `.git` can be written.

## 6. Workflow YAML

```yaml
version: 1
name: Implement & review until approved
description: Optional text
inputs:
  task: { type: string, description: What should be implemented?, required: true }
env: { CI: "1" }
steps: [ …blocks… ]
```

Common block fields: `id` (required, `^[A-Za-z_][A-Za-z0-9_-]*$`, unique per workflow),
`name` (display label, optional), `type`, `timeout` (seconds), `continueOnError`, `retry: { max, delay }`.

| type | Fields | Outputs (`steps.<id>.…`) |
|---|---|---|
| `agent` | `agent` (id or inline `{model, systemPrompt, tools, permissions…}`), `prompt`, `model?`, `output?: {format: text\|json, schema?}`, `session?: fresh\|continue`, `context?: {files: [glob]}` | `text`, `json`, `model`, `usage.inputTokens`, `usage.outputTokens`, `turns`, `status` |
| `console` | `run`, `shell?: auto\|pwsh\|powershell\|cmd\|bash\|sh`, `cwd?`, `env?` | `exitCode`, `stdout`, `stderr`, `output`, `timedOut`, `status` |
| `loop` | `until` **or** `while` (condition) or neither (fixed count¹), `maxIterations` (1–100, required), `onMaxIterations?: fail\|continue` (default `fail`), `steps` | `iterations`, `exitReason: condition\|maxIterations\|break` |
| `if` | `condition`, `then`, `else?` | `branch: then\|else`, `result` |
| `break` | — (only inside a loop) | — |
| `stop` | `outcome?: success\|failure` (default failure), `message?` | — |
| `approval` | `message`, `onReject?: stop\|continue` (default stop) | `approved`, `comment` |

¹ Implementation note: a loop without `until`/`while` runs its body exactly `maxIterations` times (unless a
Break leaves earlier) and succeeds; `onMaxIterations` only applies to loops with a condition. An `agent` block
may also omit `agent` and name only a `model` (no system prompt, no tools). Inputs are
`{ type?: string|number|boolean, description?, default?, required?, multiline? }`.

Every step also exposes `status` (`success | failure | skipped | cancelled`) and `durationMs`.

A console step **fails** when the exit code ≠ 0 unless `continueOnError: true`
(then status is `failure` but the run continues and `exitCode` is available to conditions).

Loop semantics: `until` is evaluated after each iteration (do-while); `while` before each iteration.
Inside a loop, `steps.<id>` always refers to the latest execution. `loop.iteration` is 1-based.

### Expressions and templates

- Strings may contain `${{ expression }}`. A string that is exactly one template evaluates to the
  raw value (number, boolean, object); otherwise values are stringified (objects as pretty JSON,
  null/undefined as empty string).
- Context roots: `inputs`, `steps`, `env`, `loop` (`iteration`, `index`), `workflow` (`name`, `file`),
  `workspace` (`root`), `run` (`id`), `secrets` (from SecretStorage).
- Grammar: literals (number, `'…'`/`"…"` strings, `true`, `false`, `null`), member access
  (`a.b`, `a['b']`, `a[0]`), unary `!` `-`, binary `* / % + - < <= > >= == != && ||`,
  ternary `c ? a : b`, parentheses, function calls.
- `==`/`!=`: if both sides are number-like they compare numerically, strings compare
  case-sensitively, otherwise strict equality.
- Functions: `contains(haystack, needle, ignoreCase?)` (string or array), `startsWith`, `endsWith`,
  `matches(text, pattern, flags?)`, `length(x)`, `lower`, `upper`, `trim`, `head(text, n)`,
  `tail(text, n)` (last n lines), `lines(text)`, `json(text)`, `toJSON(value)`, `join(array, sep)`,
  `default(value, fallback)`, and (added during implementation) `number(value)`, `string(value)`.
  `===`/`!==` are accepted as aliases of `==`/`!=`; list literals `['a', 'b']` are allowed.
- Evaluation never uses `eval`/`Function`; unknown identifiers resolve to `undefined`;
  unknown functions are a validation error.

### Conditions

```yaml
condition:                       # structured form (written by the condition builder)
  any:                           # all | any | not
    - { value: "${{ steps.tests.exitCode }}", op: neq, to: 0 }
    - { value: "${{ steps.review.text }}", op: contains, to: "CHANGES", ignoreCase: true }
condition: "${{ steps.tests.exitCode != 0 }}"   # expression form
```

Operators: `eq neq gt gte lt lte contains notContains matches notMatches startsWith endsWith
isEmpty isNotEmpty isTrue isFalse`. `ignoreCase` applies to string operators.

## 7. Two-way sync

- The `.workflow.yaml` text document is the single source of truth. The canvas is a
  `CustomTextEditorProvider`, so undo/redo, dirty state, save and git work natively.
- Webview → host: semantic edit operations
  (`insertStep`, `moveStep`, `deleteStep`, `updateStep`, `duplicateStep`, `renameStep`, `updateWorkflow`)
  applied by core's `applyWorkflowOps(text, ops)` to the `yaml` `Document` (comments,
  key order, formatting and CRLF line endings preserved). The host replaces only the changed text range.
  `renameStep` also rewrites `steps.<old>.` references in templates.
- Implementation note: the webview applies the same ops to its copy of the text with core right away, so
  edits show instantly; the host's next `document` message is authoritative and replaces the local result.
  Host edits are queued, so quick successive ops never race (integration test with a CRLF file).
- Host → webview: on every document change (debounced 150 ms) the host parses and validates
  and sends `{ workflow, diagnostics, text }`. Invalid YAML keeps the last valid model on the
  canvas and shows an error banner with "Show in YAML".
- Diagnostics are also published as VS Code diagnostics on the YAML file.
- Missing step ids are not invented silently: validation reports them; the canvas offers a
  one-click "Add missing ids" fix. All blocks created by the canvas get ids (`<type>_<n>`).
- No layout coordinates are stored. A generated JSON Schema is contributed through
  `yamlValidation` so hand-editing gets completion when the Red Hat YAML extension is installed.

## 8. Engine and runs

- `runWorkflow(workflow, { inputs, host, signal, budget }) → AsyncIterable<RunEvent>` (core).
- `host` implements `runConsole`, `runAgent`, `requestApproval`; logging goes through the per-step
  `StepIO.log(stream, text)` passed to each call (implementation note: no separate `host.log`).
- Events: `run-start`, `step-start`, `step-log`, `step-end`, `loop-iteration`, `run-end`.
- Cancellation via `AbortSignal` (kills process trees, aborts HTTP streams).
- Before a run: schema + semantic validation must pass; workflow inputs are requested via a dialog;
  if the console commands' content hash is not yet approved for this workspace, show them and ask.
- Runs require a trusted workspace (`capabilities.untrustedWorkspaces.supported = "limited"`: in Restricted
  Mode workflows and agents can be viewed and edited, but nothing runs).
- Run history: last 50 runs per workflow in workspace storage (events + outputs, trimmed to 1 MB each).
  Implementation notes: the limit is the setting `isarFlow.historyLimit` (default 50, 1–500); the command
  approval is remembered per workflow file and its hash also covers each block's shell, folder and env and
  the workflow env; `isarFlow.confirmCommands` can only be turned off in user settings. Runs use the
  workspace folder of the workflow file (multi-root) for console blocks, agent tools and context files.
  On deactivation, running workflows are cancelled and saved to the history before the extension stops.

## 9. UI design system

Concept: **the river.** The canvas is a single vertical stream (the Isar) on which blocks sit.
If/Else splits the stream into two arms around a gravel bank and rejoins it; a Loop is an
eddy with a return channel. During a run a current pulses down the river to the active block.
The river is the one bold element; everything else is native and quiet.

Color tokens (type colors; surfaces/text/borders come from VS Code theme variables):

| Token | Dark | Light | Use |
|---|---|---|---|
| `--if-isar` | `#5CCFC0` | `#0B7F72` | river, agent blocks, primary action (Run) |
| `--if-kies` | `#B3AC9F` | `#6B665B` | console blocks, neutral chips |
| `--if-enzian` | `#8AA4FF` | `#3550C4` | loop blocks |
| `--if-foehn` | `#E8B04E` | `#9A6400` | condition blocks |
| `--if-alpenrose` | `#F07A84` | `#C02F3C` | stop, errors |
| `--if-almgruen` | `#7BD88F` | `#2F7D3B` | approval, success |

High-contrast themes fall back to `--vscode-contrastBorder` outlines and full-strength colors.

Type: VS Code UI font for body (13px), **Barlow Semi Condensed** (bundled, OFL) for block
titles and view headings, VS Code editor font for code (commands, expressions, YAML).
Sentence case everywhere; no all-caps labels inside the webviews.

Layout:
- Workflow editor: top bar (name, validation state, Run / Stop, Open YAML) · left palette (collapsible)
  · center river canvas (scrolls) · right inspector (block form, or live output while running).
- Block card (300 px): type stone (colored icon tile), title (id or name), one-line summary
  (agent + model, command, condition text), status glyph. Insertion points (+) between cards on hover
  and as drop targets while dragging.
- Agent editor: two columns — form on the left, "Try it" chat on the right.
- Sidebar: segmented tabs, list rows with colored stones, inline actions.

Motion: only for flow — river pulse during runs, drop-target expansion while dragging, inspector
slide-in. `prefers-reduced-motion` disables the pulse.

Copy: plain verbs ("Run workflow", "Add block", "Fetch models"); errors say what happened and how to fix it.

## 10. Error handling

- Per step: `timeout`, `retry`, `continueOnError`; failed step fails the run otherwise.
- Agent JSON output that does not parse: one repair round-trip, then step failure with the raw text in the log.
- Model unavailable: try `fallbackModels`, then fail with a message naming the provider and how to fix it.
- Budget exceeded (`isarFlow.maxTokensPerRun`, 0 = unlimited): run fails with "Token budget exceeded".
- Webview never trusts host data blindly: it renders text, never HTML from model output.

## 11. Test concept

**Pyramid and tooling**

| Level | Tool | Scope | Runs in |
|---|---|---|---|
| Unit | Vitest (node) | core: expressions, templates, conditions, schemas, YAML I/O, edit ops, validation, engine, agent runtime | `npm test` |
| Contract | Vitest + local mock HTTP server | OpenAI-compatible client: model listing, SSE streaming, tool calls, JSON mode, retries, abort | `npm test` |
| Host unit | Vitest (node) | console runner (real processes, shells, timeouts, kill tree), tool host path guarding, command-approval hashing, ops→text range diff | `npm test` |
| Component | Vitest + jsdom + Testing Library | webview: canvas renders model, palette/inspector emit correct ops, condition builder round-trip, model picker grouping, run status overlay | `npm test` |
| Integration | `@vscode/test-electron` (installed VS Code) + Mocha | activation, commands, custom editor opens workflow, edit op updates document, run of a console-only workflow, run with mock LLM endpoint | `npm run test:integration` |
| Visual | Vite harness + Playwright screenshots (dark, light, high contrast) | sidebar, canvas (all block types, nested), inspector, agent editor, run states | `npm run test:visual` (manual review of PNGs) |
| Manual E2E | checklist below | real Copilot models (consent dialog), real LiteLLM proxy, Windows + Linux | before release |

**Principles**
- TDD for core and host logic: failing test first, then implementation.
- Fakes over mocks: `FakeModel` (scripted responses incl. tool calls), `FakeHost`, `MockOpenAIServer`.
- Golden YAML fixtures in `packages/core/test/fixtures`: round-trip and edit-op outputs compared
  byte-for-byte, so comment preservation regressions are caught.
- Every bug fix starts with a regression test.
- Coverage gate: core ≥ 90 % lines, extension host logic ≥ 70 % (thresholds in `vitest.config.ts`,
  checked by `npm run test:coverage`, which CI runs).

**Key scenarios**
1. Review loop: tests fail → reviewer rejects → fixer edits → tests pass → reviewer approves → loop exits with `exitReason: condition`.
2. Loop hits `maxIterations` → run fails (`onMaxIterations: fail`) / continues (`continue`).
3. `break` inside `if` inside `loop` exits only the innermost loop.
4. Console non-zero exit with/without `continueOnError`; timeout kills the process tree.
5. Cancel during agent streaming and during a long console command → run ends `cancelled`, no orphan processes.
6. Invalid YAML typed by hand → canvas keeps last valid model + error banner; fixing the YAML recovers.
7. Visual insert/move/delete in a file with comments → comments preserved, YAML still valid.
8. Agent JSON output malformed → repair retry → success; malformed twice → step failure.
9. Tool path traversal (`../../etc/passwd`, absolute paths outside workspace) → refused.
10. Model endpoint 429 then 200 → retried; endpoint down → fallback model used.

**Manual release checklist**
- Copilot model listing + consent dialog; LiteLLM discovery with key; Ollama without key.
- Dark, light, high-contrast themes; 100 % and 150 % zoom; narrow sidebar (240 px).
- Keyboard-only: add block, move selection, delete, run, cancel.
- Untrusted workspace: running is blocked with an explanation.

**CI** (GitHub Actions, windows-latest + ubuntu-latest): typecheck, lint, unit/contract/component tests,
integration tests (xvfb on Linux), build `.vsix` artifact.

## 12. Out of scope for v1

LLM-judge conditions, ForEach/Parallel/sub-workflows, MCP and `vscode.lm.tools`, external agent CLIs,
AI-generated workflows, headless CLI, triggers on save/git hooks, cost tracking in currency.
