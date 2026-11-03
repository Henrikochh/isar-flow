# Isar Flow — UI design brief

Companion to the spec (§9). Every webview must follow this brief so the product reads as one system.

## Principles

1. **The river is the one bold element.** A turquoise stream runs down the canvas; blocks sit on it.
   Everything else is quiet, native VS Code chrome built from theme variables.
2. **Native first.** Surfaces, text, borders, inputs and focus come from `--if-*` tokens, which map to VS Code
   theme variables (`src/theme/tokens.css`). Never hard-code colors except the Isar palette tokens.
3. **Show the real thing.** Cards show the actual prompt, command and condition — not generic labels.
4. **Motion only for flow.** The river pulse during runs, drop slots opening while dragging, the inspector
   sliding in. Nothing animates on load. `prefers-reduced-motion` is respected globally in `base.css`.
5. **Sentence case, plain verbs.** "Run workflow", "Add block", "Fetch models". No all-caps labels, no
   decorative eyebrows, no "A · B · C" meta strings (use separate chips or spans), no "→" in button text.
   Errors say what happened and how to fix it.

## Building blocks

- Use the kit in `src/components` (Button, IconButton, Field, TextInput, TextArea, Select, ModelPicker, Switch,
  Checkbox, SegmentedControl, Chip, Stone, AgentStone, Banner, EmptyState, StatusGlyph, Dialog, Kbd, Section).
  Do not create new button or input styles. If something is missing, add it to the kit in the same style.
- Icons: codicons only (`<i className="codicon codicon-NAME" />`). Block icons: `BLOCK_ICONS` in `src/blockMeta.ts`.
- Typography: body = VS Code UI font 13px (`--if-text-m`); headings and block titles = `.if-display`
  (Barlow Semi Condensed 600); code (commands, expressions, YAML, ids, paths) = `--if-font-code`.
  Scale: 11 / 12 / 13 / 15 / 19 / 24 px.
- Spacing: 4 / 8 / 12 / 16 / 24 / 32 (`--if-space-*`). Radii: 4 / 6 / 10 px; cards 10 px, pills 999 px.
- Each view keeps its CSS in co-located files with a view prefix: `sb-` (sidebar), `wf-` (workflow), `ag-` (agent).
  Keep selectors flat (one class) to avoid specificity fights.
- Block colors: put `data-type="<block type>"` on an element to get `--block-color` / `--block-wash`.
- Every interactive element is reachable by keyboard and shows the `:focus-visible` outline.
- Text meets WCAG AA in dark, light and high contrast themes: 4.5:1 (3:1 for large text) against its background.
  **Dimmed states never fade text.** Skipped blocks, blocks a run has not reached and hidden agents show it with
  the frame (hollow, dashed), a faded stone or river segment and a muted (still 4.5:1) title, plus a glyph or chip
  that names the state. `scripts/interactions.mjs` measures every view, these states included.
  Palette-colored text on a wash of its own color (toned chips, badges, the validity pill) mixes in `--if-fg`
  by `--if-ink-strength` (100 % in dark themes, 72 % in light ones) so it keeps 4.5:1 on the wash.
- SegmentedControl: the selected segment is tinted and ringed with the text color, so it stands out on any
  theme's input background (its edge has at least 3:1 against the track); high contrast themes ring it with
  `contrastActiveBorder`.
- Text from models or logs is rendered as plain text (`white-space: pre-wrap`), never as HTML.

## Sidebar (view `sidebar`, ~240–400 px wide)

```
┌──────────────────────────────────┐
│ [ Agents 3 ][ Workflows 4 ]       │  SegmentedControl role=tablist, full width, sticky top
│                                   │
│ Agents                    [+ New] │  Section title (display font) + small secondary button
│ ┌───────────────────────────────┐ │
│ │ (CO) Coder            ⋯       │ │  row: AgentStone, name (600), hover actions (open YAML, delete)
│ │      litellm/claude-sonnet    │ │  model in code font, muted, ellipsis; User chip for user scope
│ │      ◇ 7 tools  Edits: auto   │ │  small chips: tool count, permissions when not none
│ └───────────────────────────────┘ │
│ Models                 [⟳] [+]    │
│ ● VS Code         12 models       │  status dot: almgruen ok, foehn loading, alpenrose error
│ ● LiteLLM         8 models        │
│ ● Ollama  Cannot reach localhost… │  error text in muted alpenrose, row clickable → editProvider
└──────────────────────────────────┘
```

- Rows are buttons: click opens the agent editor / workflow canvas. Hover background `--if-hover`;
  rows have 8 px radius and 8 px padding. No card borders around rows.
- A user agent hidden by a workspace agent with the same id shows a warning chip "Hidden"; its stone fades to
  45 % and its name turns muted (text keeps 4.5:1).
- **New agent** expands an inline card at the top of the list: name field, starter
  (SegmentedControl: Blank / Coder / Reviewer), scope (Workspace / User), buttons Create agent / Cancel.
- Workflows tab:

```
│ Workflows                 [+ New] │
│ ┌───────────────────────────────┐ │
│ │ ⟿ Review until approved   [▶] │ │  isar-tinted tile with codicon `pulse`; run IconButton on the right
│ │   .isarflow/workflows/review…  │ │  relative path, code font, muted
│ │   ✓ Succeeded  4 min ago       │ │  last run: StatusGlyph + label + relative time (separate spans)
│ └───────────────────────────────┘ │
│ Recent runs                        │
│  ✓ review-loop   4 m 12 s  just now│  clickable → openRun
```

- **New workflow** inline card: name, template cards (Blank — "Start empty"; Review loop — "Implement,
  test and review until approved"; Test and fix — "Run tests and fix failures until they pass"), Create workflow.
- Running workflows show a spinner and a Stop IconButton instead of Run.
- Empty states: Agents — "No agents yet" / "Agents are reusable AI helpers with a model, instructions and tools."
  / Create agent. Workflows — "No workflows yet" / "Chain agents, console commands, loops and conditions."
  / Create workflow. No workspace — "Open a folder to use Isar Flow" (no actions).
- Restricted mode: Banner warning "Running is disabled until you trust this workspace."

## Workflow editor (view `workflow`, editor area)

```
┌─ TopBar ───────────────────────────────────────────────────────────────────────────────┐
│ Review until approved   review.workflow.yaml        ✓ Ready     [Runs ▾] [Open YAML] [▶ Run] │
├──────────┬──────────────────────────────────────────────────────────┬───────────────────┤
│ Blocks   │                       ◉ Start                            │ Inspector (360px) │
│ ◆ Agent  │                       │  inputs: task                    │                   │
│ ▣ Console│               ┌───────┴─────────┐                        │                   │
│ ↻ Loop   │               │ ◆ implement      │                        │                   │
│ ⑂ If     │               └───────┬─────────┘                        │                   │
│ ⤴ Break  │                       +                                  │                   │
│ ■ Stop   │       ┌─ ↻ Repeat until review approved ── max 5 ┐       │                   │
│ ✓ Approv │      ↺│         ┌─────────────┐                  │       │                   │
│          │      ││         │ ▣ tests      │                  │       │                   │
│ Agents   │      ││         └──────┬──────┘                  │       │                   │
│ (CO) Cod │      ││         ┌──────┴──────┐                  │       │                   │
│ (RV) Rev │      ││         │ ◆ review     │                  │       │                   │
│          │       └──────────────────────────────────────────┘       │                   │
│ + New    │                       ◉ End                              │                   │
└──────────┴──────────────────────────────────────────────────────────┴───────────────────┘
```

### Top bar (48 px)

- Workflow name in display font 19 px, editable inline (click → TextInput, Enter/blur commits `updateWorkflow`).
- File name muted after it. Validation pill: "Ready" (almgruen check) or "N problems" (alpenrose/foehn) —
  click opens a popover listing diagnostics (icon, message, block id); clicking one selects the block, or
  for YAML-level issues calls `openYaml`.
- Right: Runs menu (history: StatusGlyph, relative time, duration; "Live run" when one is active),
  Open YAML (ghost, icon `go-to-file`), Run (variant `run`, icon `play`). While running: elapsed time,
  Stop (variant danger, icon `debug-stop`). Run disabled when untrusted or invalid (tooltip says why).

### Palette (220 px, collapsible to 48 px icon rail)

- "Blocks": one draggable item per block type: Stone + label + one-line description (STEP_TYPE_INFO).
  Click inserts after the selected block (or at the end of the root list).
- "Agents": every agent as a draggable item (AgentStone + name); dropping creates an agent block with
  `agent: <id>` and an empty prompt.
- Footer link "New agent".

### Canvas — the river

- Scrolls both ways; content centered with 48 px padding; dot-free plain background (`--if-bg`).
- Zoom: Ctrl/Cmd + wheel and a small control bottom-right (−, percentage, +, fit) using CSS `zoom` (0.5–1.5).
- **River**: a 3 px vertical line (`--if-river`) through the center of each list. Start marker at the top
  (small circle with `play` glyph, label "Start", input names as chips), End marker at the bottom
  ("End"). Segments between blocks are 32 px tall.
- **Insertion points** sit on every segment: on hover a 20 px round "+" appears (isar outline); click
  opens a compact block picker popover. While dragging, every insertion point opens into a 36 px dashed
  drop slot; the hovered slot fills with `--block-wash` of the dragged type. Empty lists render one slot
  with the text "Drop a block here".
- **Block card** (300 px wide, radius 10, `--if-surface`, 1 px `--if-border`; type color only in the Stone
  and the selection ring):
  - Row 1: Stone, title (block `name` or `id`, display font 15 px), status glyph (during runs) or
    problem badge (diagnostics count, alpenrose).
  - Row 2+ per type:
    - agent: AgentStone (s) + agent name + model (code font, muted); prompt first line(s), 2-line clamp,
      muted; chip "JSON answer" when output.format json.
    - console: command in code font on a sunken strip (1 line, ellipsis); chips "pwsh"/… when shell set,
      "Continues on error" when continueOnError.
    - break: compact pill card (36 px tall) "Leave loop".
    - stop: "End run as failed/succeeded" + message.
    - approval: "Ask for approval" + message, 2-line clamp.
  - Selected: 2 px ring in `--block-color` (outline, no layout shift). Hover: border `--if-border-strong`.
- **Loop** (container): frame with 1 px border in `color-mix(--if-enzian 40%)`, radius 14, header strip
  with Stone, title, summary ("Repeat until review.json.approved is true" / "Repeat while …" /
  "Repeat 5 times"), chip "max 5". On the left side of the frame an **eddy**: a return channel drawn as an
  SVG path from the bottom of the body curving up to the header, with an arrowhead, in `--if-enzian`.
  During a run the header shows "Iteration 2 of 5".
  When the frame is scrolled sideways, the stone and titles stay in view on the left and the chips on the
  right. Text that reaches the chips runs under them: they sit on the opaque header color, as tall as the
  header, with a 20 px fade.
- **If** (container): header card with Stone + "If tests.exitCode ≠ 0" (describeCondition). Below, the river
  forks into two equal-width lanes (CSS grid `1fr 1fr`) labelled "Then" and "Else"; the fork and merge
  are drawn with 3 px rounded connectors so the split looks like a river around a gravel bank.
  Empty lanes show a drop slot.
- **Run state**: segments the run has passed are full strength; segments not reached are 35 % opacity;
  the segment above the running block shows a flowing current (animated dashes moving down, 1.2 s loop).
  Running card: outline glow `0 0 0 3px color-mix(--if-isar 35%)`. Succeeded/failed/skipped glyphs in the
  card. Skipped cards (an If branch the run did not take) are hollow with a dashed `--if-border-strong` border,
  no shadow, a stone at 45 % opacity and a muted title; skipped loops get a dashed frame. Text is never faded.
- **Keyboard**: arrows move selection (document order), Delete/Backspace deletes, Ctrl/Cmd+D duplicates,
  Alt+↑/↓ moves the block within its list, Enter focuses the inspector, Escape clears selection.
- **Drag & drop**: dnd-kit. Drag existing cards (move) or palette items (insert). Drop on insertion slots
  only; dropping a container into itself is impossible (its slots are disabled while dragging it).

### Inspector (360 px, right)

- No selection: **Workflow** panel — Name, Description, Inputs (rows: name, type, required, default,
  description; "Add input"), Environment variables (key/value rows), and the run history list.
- Block selected: header with Stone, editable name (placeholder = id), id field (code font; commits
  `renameStep` on blur, shows validation errors inline), actions: Duplicate, Show in YAML, Delete.
  When a run is shown, a SegmentedControl switches **Settings** / **Run output**.
- Fields per type (labels exactly):
  - Agent: "Agent" (Select of agents + "No agent — use a model directly"), "Model" (ModelPicker,
    placeholder "Use the agent's model"), "Task" (TextArea, autoGrow, with `{x}` insert-variable button),
    "Answer format" (Text / JSON), "JSON fields" (rows key + type select: text, number, yes/no, list of text,
    object; optional checkbox), "Remember the conversation between loop iterations" (Switch → session),
    "Context files" (glob rows), Advanced (collapsed): Timeout (seconds), Retries, Continue on error.
  - Console: "Command" (TextArea code, autoGrow, `{x}` button), "Shell" (Automatic, PowerShell 7, Windows
    PowerShell, Command Prompt, Bash, sh), "Working folder" (placeholder "Workspace root"), "Environment",
    "Continue on error" (hint: "Keep going when the command fails, so a condition can check the exit code"),
    Advanced: Timeout, Retries.
  - Loop: "Repeat" (SegmentedControl: Until / While / Fixed times), condition builder, "Maximum iterations"
    (1–100), "When the limit is reached" (Fail the run / Continue).
  - If: condition builder.
  - Break: explanation text "Leaves the innermost loop immediately."
  - Stop: "End the run as" (Failed / Succeeded), "Message".
  - Approval: "Message", "If rejected" (Stop the run / Continue).
- **Condition builder**: mode switch Rules / Expression. Rules: combinator Select ("All rules match" /
  "Any rule matches") and rows `[value] [operator] [operand] [remove]`; value is a searchable Select of
  `availableVariables` (grouped Inputs / Blocks / Loop) that also accepts custom text; operator from
  `CONDITION_OPS` labels; operand hidden for operand-free operators; "+ Add rule". Below, a muted live
  summary using `describeCondition`. Expression mode: code TextInput with inline parse error. Deeper
  nesting than one group: show the summary and a Banner "This condition has nested groups. Edit it in
  YAML." with Open YAML.
- **Variable picker** (`{x}`): popover listing `availableVariables(workflow, stepId)` grouped, searchable;
  choosing inserts `${{ expression }}` at the caret.
- Text fields use `useDraft` (commit after 350 ms idle and on blur) so typing is never clobbered.
- **Run output** tab: status line (StatusGlyph, label, duration, "Iteration 2"), "Sent to the agent" /
  "Command" (collapsible code block of `detail`), then output: console → exit code chip + log viewer
  (monospace, stderr lines in alpenrose, auto-scroll while running, Copy button); agent → answer text,
  JSON (pretty, code font), token chips, tool lines; errors as Banner error.
- No block selected during a run: run summary (status, duration, tokens) and list of blocks with status.
  Blocks not reached or skipped are quiet: their river segment fades to 35 %, the stone to 45 % and the title
  turns muted.

### Dialogs and banners

- Run with inputs → Dialog "Run <name>" with one Field per input (TextArea when multiline), values
  remembered per workflow (setViewState), primary button "Run workflow".
- Approval pending → Banner success-toned pinned at top of the canvas: "Approval needed" + message,
  optional comment TextInput, buttons Approve (run variant) / Reject (danger). The approval card on the
  river pulses its ring.
- YAML syntax error → Banner error over the canvas: "The YAML can't be read: <message> (line N)" with
  "Show in YAML"; the canvas keeps rendering the last valid model at 60 % opacity.
- Ops error → dismissible Banner error.
- Restricted mode → Banner warning, Run disabled; the banner offers a Simulate action.
- Simulated runs never look like real runs. They use the enzian tone and the beaker icon (Chip tone
  `simulated`, Banner tone `simulated`, Button variant `simulate`, token `--if-on-enzian`), never the isar/run
  colors. The canvas pins a Banner "Simulated run" ("Simulating" while it runs) with an inline "Edit mocks"
  link, and live-value labels say "Last simulation" / "This simulation" instead of "Last run" / "This run".
  Run stays the primary action; Simulate lives in the split button's menu.
- Empty workflow → river Start/End markers with a centered EmptyState between them: "Add your first block"
  / "Drag a block from the left or click one to add it." / buttons "Add agent", "Add console command".

## Agent editor (view `agent`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ (RV)  Reviewer                         Workspace     [Open YAML]             │
│       Strict senior code reviewer                                              │
├───────────────────────────────────────────────┬──────────────────────────────┤
│ Model                                          │ Try it                        │
│   Model           [LiteLLM ▸ claude-sonnet ▾]  │  ┌──────────────────────────┐ │
│   Fallback models (chips) [+ Add]              │  │ you: Review src/app.ts   │ │
│   Temperature [0.2]  Max tokens [4000]         │  │ ◆ Reviewer: …streaming   │ │
│   Max turns [20]                               │  │ ⚙ readFile src/app.ts    │ │
│ Instructions                                   │  └──────────────────────────┘ │
│   [ big TextArea, autoGrow, code-ish ]         │  [Ask the agent…     ][Send] │
│ Tools                                          │  Uses the settings in this   │
│   [x] Read files       Read workspace files    │  editor, unsaved changes     │
│   [x] Search           …                       │  included. Edits and         │
│ Permissions                                    │  commands ask first.         │
│   Edit files    (Never | Ask | Always)         │                              │
│   Run commands  (Never | Ask | Always)         │                              │
│ Used by  review.workflow.yaml                  │                              │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

- Header: AgentStone (l), name (display 24 px, inline editable), description (inline editable, muted),
  scope chip, Open YAML. Form column max-width 640 px; Try it column 380 px, sticky full height.
- All edits post `update` with `useDraft` debounce; schema errors from diagnostics show under the field.
- Model picker groups by provider, shows capability chips (Tools, JSON), filter box, "Refresh models" and
  "Add endpoint" footer actions; providers in error state appear as disabled group headers with the error.
- Try it: transcript bubbles — user messages right-aligned with `--if-hover` background; agent messages
  left with AgentStone; tool lines as compact rows with `tools` codicon; streaming caret; Stop button
  while streaming; token/model line after each answer. Empty: "Ask the agent something to see how it
  responds with the current settings."
- Invalid file → Banner error with the first diagnostic and Open YAML.
