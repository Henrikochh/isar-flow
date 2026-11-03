# Isar Flow

Configure AI agents and chain them into workflows, right inside VS Code. A workflow is a YAML file made of
blocks: agents that read and edit your code, console commands, loops, conditions and approvals. Build it on a
visual canvas, the river, or write the YAML by hand; both are views of the same file and stay in sync,
comments included. Agents use the models VS Code offers (such as GitHub Copilot) or any OpenAI-compatible
endpoint, such as LiteLLM, Ollama, vLLM or OpenRouter.

A typical workflow: an agent implements a task, your tests run in the console, a reviewer agent checks the
result, and a loop repeats the fix until the tests pass and the reviewer approves.

## Features

- **River editor**: blocks sit on a vertical stream; If / else splits it into two lanes, a loop draws a return
  channel. Add blocks from the palette or with the **+** between blocks, drag them, or move them with **Move
  to…** and the keyboard. Every visual edit changes only the affected lines of the YAML and keeps your
  comments. Problems show up as you type, on the canvas and in the Problems view.
- **Blocks**: Agent, Console, Loop (until, while or a fixed number of times), If / else, Break, Stop and
  Approval (a person decides before the run goes on).
- **Expressions and conditions**: `${{ steps.tests.exitCode == 0 }}`, `${{ tail(steps.tests.output, 80) }}`,
  17 functions, and a condition builder that writes rules for you.
- **Agents**: create agents for the workspace (`.isarflow/agents/`) or for your user. Each has a model,
  fallback models, a system prompt, built-in tools and permissions. **Try it** chats with an agent before
  you use it in a workflow.
- **JSON answers**: describe the expected shape and later blocks read fields such as
  `steps.review.json.approved`. An answer that does not fit gets one repair round.
- **Live runs**: block status and loop iterations on the canvas, rendered prompts and outputs in the
  inspector, console output mirrored to a terminal, approvals inline, and a history of recent runs. Every
  block shows its time, tokens and (with prices set) cost, with averages over the last 20 runs.
- **Review every change**: after a run, a review card lists the changed files with diffs; keep or revert
  each one. In a git repository, snapshots before and after each run cover console commands too, without
  touching your index or branch. `isolation: worktree` runs a workflow on a separate git worktree.
- **Built-in agent tools**: `readFile`, `listFiles`, `searchText`, `gitDiff`, `editFile`, `applyPatch`,
  `writeFile` and `runCommand`. Edits go through VS Code, so you can undo them. Badges show whether an agent
  is read-only, edits files or runs commands.
- **Local models**: tolerant edits and patches, tool calls written as text for models without native tool
  calling, and conversation summaries before the context runs out. **Test model** and **Check setup** show
  what works and how to fix the rest.

## Quick start

1. Open a folder and select the **Isar Flow** icon in the Activity Bar.
2. On the **Workflows** tab, select **New**, enter a name and choose the **Review loop** template. Isar Flow
   creates the workflow and, if they are missing, the agents `coder` and `reviewer`.
3. Pick models for the agents: open each one from the **Agents** tab and choose a model. With GitHub Copilot
   installed, its models are listed under **VS Code**. To use your own server, see
   [Model endpoints](#model-endpoints).
4. In the workflow, select the `tests` block and replace `npm test` with your test command. Select **Run**,
   enter the task and confirm the console commands.

You can also start a run from the sidebar, with the **Run workflow** CodeLens at the top of a
`.workflow.yaml` file, from the file's context menu, or with **Isar Flow: Run workflow**.

## The river editor

| Keys                     | Action                                                          |
| ------------------------ | --------------------------------------------------------------- |
| ↓ / → and ↑ / ←          | Select the next or previous block                               |
| Alt+↑ / Alt+↓            | Move the selected block within its list                         |
| Delete / Backspace       | Delete the selected block                                       |
| Ctrl+D (Cmd+D)           | Duplicate the selected block                                    |
| Shift+F10                | Open the block menu (Move to…, Duplicate, Show in YAML, Delete) |
| Enter / Escape           | Go to the inspector / clear the selection                       |
| Ctrl / Cmd + mouse wheel | Zoom                                                            |

**Open YAML** shows the text beside the canvas. When the YAML cannot be read, the canvas keeps the last
readable version and tells you which line to fix.

## Model endpoints

Agents refer to models as `<provider>/<model>`, for example `litellm/gpt-4.1` or `vscode/copilot/gpt-4.1`.

**VS Code models** need no setup. The first time an agent uses one, VS Code asks you to allow Isar Flow to
use it. Turn them off with the `isarFlow.vscodeModels` setting.

**OpenAI-compatible endpoints**: run **Isar Flow: Add model endpoint** (or select **+** under **Models** in
the sidebar) and pick a preset (LiteLLM, Ollama, OpenRouter, OpenAI) or **Custom…**. Isar Flow asks for an
id, the base URL and the API key, then lists the endpoint's models with `GET /models`.

### LiteLLM

1. Start the proxy, for example `litellm --config config.yaml` (it listens on `http://localhost:4000`).
2. Run **Isar Flow: Add model endpoint**, choose **LiteLLM**, keep the id `litellm` and the URL, and enter
   your LiteLLM key (a virtual key or the master key). Leave it empty if your proxy has no key.
3. The models of your `model_list` appear in the model pickers as `litellm/<model_name>`.

The endpoint is stored in your settings; the key is stored in VS Code's secret storage, never in settings:

```jsonc
// settings.json
"isarFlow.providers": [
  { "id": "litellm", "label": "LiteLLM", "baseUrl": "http://localhost:4000" },
  { "id": "ollama", "label": "Ollama", "baseUrl": "http://localhost:11434/v1" },
  // When a server cannot list its models, name them yourself:
  { "id": "vllm", "baseUrl": "http://gpu-box:8000/v1", "discoverModels": false, "models": ["qwen2.5-coder"] }
]
```

Use **Isar Flow: Edit model endpoint**, **Set provider API key** and **Test model endpoint** to manage
endpoints. Requests that fail with a rate limit, a server or a network error are retried; after that an
agent's `fallbackModels` are tried in order.

## Agents

```yaml
# .isarflow/agents/reviewer.agent.yaml — workflows use it as "agent: reviewer"
name: Reviewer
description: Strict senior code reviewer
model: litellm/claude-sonnet
fallbackModels: [vscode/copilot/gpt-4.1]
systemPrompt: |
  You are a strict senior reviewer. Answer with JSON only.
temperature: 0.2
maxTurns: 20
tools: [readFile, listFiles, searchText, gitDiff]
permissions: { edits: none, commands: none } # none | ask | auto
```

`permissions.edits` gates `editFile` and `writeFile`, `permissions.commands` gates `runCommand`; reading
tools never ask. `none` refuses, `auto` allows, and `ask` (also what an unset level means) shows a dialog with
**Allow**, **Allow for this run** and **Deny**. A refused call is reported to the model as a tool error.
**Try it** always asks instead of `auto`. Workspace agents win over user agents with the same id.

## Workflow YAML

```yaml
# .isarflow/workflows/review.workflow.yaml
version: 1
name: Implement & review until approved
inputs:
  task: { type: string, description: What should be implemented?, required: true }
env: { CI: '1' }
steps:
  - id: implement
    type: agent
    agent: coder
    prompt: 'Implement: ${{ inputs.task }}'

  - id: review_loop
    type: loop
    until: '${{ steps.tests.exitCode == 0 && steps.review.json.approved }}'
    maxIterations: 5
    steps:
      - id: tests
        type: console
        run: npm test
        continueOnError: true
      - id: review
        type: agent
        agent: reviewer
        prompt: 'Tests exited with ${{ steps.tests.exitCode }}. Review the changes.'
        output: { format: json, schema: { approved: boolean, issues: 'string[]' } }
      - id: needs_fix
        type: if
        condition: '${{ !steps.review.json.approved }}'
        then:
          - id: fix
            type: agent
            agent: coder
            prompt: 'Fix: ${{ toJSON(steps.review.json.issues) }}'
```

| Block      | Main fields                                                                                                                                                 | Outputs (`steps.<id>.…`)                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `agent`    | `agent` (id or inline settings), `prompt`, `model`, `output: { format: text \| json, schema }`, `session: fresh \| continue`, `context: { files: [globs] }` | `text`, `json`, `model`, `usage`, `turns`            |
| `console`  | `run`, `shell` (`auto`, `pwsh`, `powershell`, `cmd`, `bash`, `sh`), `cwd`, `env`                                                                            | `exitCode`, `stdout`, `stderr`, `output`, `timedOut` |
| `loop`     | `until` or `while` (or neither: a fixed count), `maxIterations` (1–100, required), `onMaxIterations: fail \| continue`, `steps`                             | `iterations`, `exitReason`                           |
| `if`       | `condition`, `then`, `else`                                                                                                                                 | `branch`, `result`                                   |
| `break`    | ends the innermost loop                                                                                                                                     |                                                      |
| `stop`     | `outcome: success \| failure`, `message`                                                                                                                    |                                                      |
| `approval` | `message`, `onReject: stop \| continue`                                                                                                                     | `approved`, `comment`                                |

Every block also accepts `name`, `timeout` (seconds), `continueOnError` and `retry: { max, delay }`, and
exposes `status`, `durationMs` and, when it failed, `error`. A console block fails on a non-zero exit code
unless `continueOnError: true` is set.

**Expressions**: `${{ … }}` inside any string. Roots: `inputs`, `steps`, `env`, `loop` (`iteration`,
`index`), `workflow`, `workspace`, `run` and `secrets`. Operators: `! - * / % + < <= > >= == != && ||` and
`a ? b : c`. Functions: `contains`, `startsWith`, `endsWith`, `matches`, `length`, `lower`, `upper`, `trim`,
`head`, `tail`, `lines`, `json`, `toJSON`, `join`, `default`, `number`, `string`.

**Conditions** can also be written as rules, which is what the condition builder on the canvas writes:

```yaml
condition:
  any:
    - { value: '${{ steps.tests.exitCode }}', op: neq, to: 0 }
    - { value: '${{ steps.review.text }}', op: contains, to: CHANGES, ignoreCase: true }
```

Operators: `eq neq gt gte lt lte contains notContains matches notMatches startsWith endsWith isEmpty
isNotEmpty isTrue isFalse`, combined with `all`, `any` and `not`.

With the [YAML extension by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
installed, workflow and agent files get completion and validation from the bundled JSON Schemas.

## Secrets

Run **Isar Flow: Set workflow secret** to store a value in VS Code's secret storage, then use it as
`${{ secrets.NAME }}`. Every stored secret is available to every workflow you run in a trusted workspace.
Values of 4 or more characters are replaced with `••••••` in run events, the terminal, the history and
approval prompts.

## Security

Isar Flow runs commands and lets models act in your workspace. Review workflows and agents written by others
before you run them.

- **Workspace Trust**: workflows and agents can be viewed and edited in Restricted Mode, but nothing runs,
  and only your user model endpoints are used.
- **Run confirmation**: before a workflow runs console commands or agents that can change your workspace
  without asking, and you have not approved them yet, Isar Flow lists them and asks. The list shows commands
  with their shell, folder and environment, and agents with `edits` or `commands` set to `auto` (and a tool
  that uses it) with what they may do. A changed command or a change to such an agent's tools or permissions
  needs approval again. Only your user settings can turn this off (`isarFlow.confirmCommands`).
- **Templates are not escaped**: `${{ }}` values (inputs, block outputs including model answers, env and
  secrets) are pasted into a console block's command line, folder and environment as they are, and the
  confirmation shows the template, not the rendered command. Pass user input and agent output through `env`
  and quote it in the shell instead of putting it into the command line.
- **Agent permissions**: once you run a workflow, agents with `edits` or `commands` set to `auto` act without
  asking, and a workflow from a repository can use such agents. Read the confirmation list before you run
  workflows written by others.
- **Agent tools** only reach files inside the workflow's workspace folder, checked after resolving links,
  junctions and Windows short names; nothing inside `.git` can be written. Within that folder agents can
  read every file, including `.env` files, and send it to the model provider.
- **Workspace endpoints**: in a trusted workspace, `.vscode/settings.json` can define model endpoints. One
  with the same id as yours replaces it and receives your stored API key.
- **Not sandboxed**: commands run with your VS Code environment, including credentials in environment
  variables.
- **Snapshots**: in a git repository, the before and after snapshots of each run are commits under
  `refs/isarflow/runs/`, on no branch, removed with the run history. A normal `git push` doesn't send them.
- **Runs always end**: loops need `maxIterations`, agents have `maxTurns`, blocks can have a `timeout`, and
  `isarFlow.maxTokensPerRun` stops a run that uses too many tokens. **Stop** ends a run and the processes it
  started.
- API keys and secrets are kept in VS Code's secret storage, never in settings or workflow files. Model output
  is shown as text, never rendered as HTML.

## Settings

| Setting                       | Default | Description                                                                                                         |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `isarFlow.providers`          | `[]`    | OpenAI-compatible model endpoints.                                                                                  |
| `isarFlow.vscodeModels`       | `true`  | Offer the language models available in VS Code.                                                                     |
| `isarFlow.defaultShell`       | `auto`  | Shell for console blocks without `shell` and for agent commands: PowerShell on Windows, your login shell elsewhere. |
| `isarFlow.maxTokensPerRun`    | `0`     | Stop a run after this many tokens. `0` means no limit.                                                              |
| `isarFlow.confirmCommands`    | `true`  | Ask before running console commands or agents that act without asking, until you approve them. User settings only.  |
| `isarFlow.historyLimit`       | `50`    | Runs kept per workflow (1–500). Snapshots and worktrees of older runs are removed too.                              |
| `isarFlow.agentContextTokens` | `24000` | Context size for models that don't report one. Agent conversations are summarized at 70 % of it.                    |
| `isarFlow.modelPrices`        | `{}`    | Prices per 1 million input and output tokens by model reference, for cost estimates.                                |

## Troubleshooting

Run **Isar Flow: Show log** to see what happened during activation, model discovery and runs.

- _A model is missing_: run **Isar Flow: Refresh models** or **Isar Flow: Test model endpoint**. The base
  URL may end with or without `/v1`: when the plain URL answers 404, Isar Flow tries `<url>/v1`.
- _VS Code models fail with a permission error_: allow Isar Flow when VS Code asks, or under **Accounts →
  Manage Language Model Access**.
- _A command works in your terminal but not in a workflow_: set `shell` on the block, or change
  `isarFlow.defaultShell`.
- _Run is disabled_: hover it to see why (untrusted workspace, unreadable YAML, problems, or no blocks).
- _A local model doesn't use its tools_: run **Isar Flow: Test model**. A model that needs text tool mode
  works with **Tool calls** on **Automatic** after the test, or set **Tool calls** to **Text in the prompt**.
- _Something doesn't work and you don't know where to start_: run **Isar Flow: Check setup**. It checks
  every endpoint and model your workflows use and offers a fix for each problem.
- _"Isolation worktree needs a git repository"_: run `git init` in the folder, or set **Run in** back to
  **Workspace**.

## License

MIT
