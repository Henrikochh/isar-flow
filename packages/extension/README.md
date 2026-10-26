# Isar Flow

Configure AI agents and chain them into workflows, right inside VS Code. Build a workflow on a visual
canvas, or write it as YAML; both are views of the same file and stay in sync. Agents can use the models
VS Code offers (such as GitHub Copilot) or any OpenAI-compatible endpoint, such as LiteLLM, Ollama, vLLM or
OpenRouter.

A typical workflow: an agent implements a task, your tests run in the console, a reviewer agent checks the
result, and a loop repeats the fix until the tests pass and the reviewer approves.

## Features

- **Agents view**: create agents for the workspace (`.isarflow/agents/`) or for your user. Each agent has a
  model, fallback models, a system prompt, tools and permissions. Use **Try it** to chat with an agent
  before you put it in a workflow.
- **Workflow canvas**: blocks sit on a vertical stream. Drag blocks from the palette, edit them in the
  inspector, and see problems as you type. Every visual edit rewrites the YAML and keeps your comments.
- **Blocks**: Agent, Console, Loop, If/Else, Break, Stop and Approval (a human decides before the run goes on).
- **Live runs**: the canvas shows which block is running, console output is mirrored to a terminal tab, and
  recent runs are kept in a history you can open again.
- **Built-in agent tools**: `readFile`, `listFiles`, `searchText`, `gitDiff`, `editFile`, `writeFile` and
  `runCommand`. Edits go through VS Code, so you can undo them.

## Quick start

1. Open a folder and select the **Isar Flow** icon in the Activity Bar.
2. On the **Workflows** tab, select **New workflow** and choose the **Review loop** template. Isar Flow creates
   the workflow and, if they are missing, the agents `coder` and `reviewer`.
3. Pick models for the agents: open each agent and choose a model. With GitHub Copilot installed, its models
   are listed under **VS Code**. To use your own endpoint, see [Model endpoints](#model-endpoints).
4. In the workflow, replace `npm test` with your test command, then select **Run**. Enter the task when
   asked, and confirm the console commands the first time.

You can also start a run with the **Run workflow** CodeLens at the top of a `.workflow.yaml` file, from the
file's context menu, or with **Isar Flow: Run workflow** in the Command Palette.

## Model endpoints

Agents refer to models as `<provider>/<model>`, for example `litellm/gpt-4.1` or `vscode/copilot/gpt-4.1`.

**VS Code models** need no setup. The first time an agent uses one, VS Code asks you to allow Isar Flow to
use it. Turn them off with the `isarFlow.vscodeModels` setting.

**OpenAI-compatible endpoints**: run **Isar Flow: Add model endpoint** and pick a preset (LiteLLM, Ollama,
OpenRouter, OpenAI) or **Custom…**. Isar Flow asks for an id, the base URL and the API key, then lists the
endpoint's models with `GET /models`.

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

Use **Isar Flow: Set provider API key** to change a key and **Isar Flow: Test model endpoint** to check a
connection. Failed requests (rate limits, server errors) are retried; after that an agent's
`fallbackModels` are tried in order.

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

`ask` shows a dialog with **Allow**, **Allow for this run** and **Deny**. A denied call is reported to the
model as a tool error. Workspace agents win over user agents with the same id.

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
| `loop`     | `until` or `while`, `maxIterations` (1–100, required), `onMaxIterations: fail \| continue`, `steps`                                                         | `iterations`, `exitReason`                           |
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

**Conditions** can also be written as data, which is what the condition builder on the canvas writes:

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
`${{ secrets.NAME }}`. Secret values are replaced with `••••••` in run output, the run view and the
history.

## Security

- **Workspace Trust**: workflows and agents can be viewed and edited in Restricted Mode, but nothing runs.
- **Console commands**: before a workflow runs commands you have not approved yet, Isar Flow lists them and
  asks. A changed command needs approval again. Turn this off with `isarFlow.confirmCommands` only for
  workflows you trust.
- **Agent tools** only reach files inside the workspace folder. Paths that leave it (`..`, absolute paths,
  links pointing outside) are refused, and writes inside `.git` are refused. Edits and commands follow the
  agent's `permissions`.
- **Runs always end**: loops need `maxIterations`, agents have `maxTurns`, blocks can have a `timeout`, and
  `isarFlow.maxTokensPerRun` stops a run that uses too many tokens. **Stop** ends a run and the processes it
  started.
- API keys and secrets are kept in VS Code's secret storage, never in settings or workflow files.
- Model output is shown as text; it is never rendered as HTML.

## Settings

| Setting                    | Default | Description                                                                                  |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `isarFlow.providers`       | `[]`    | OpenAI-compatible model endpoints.                                                           |
| `isarFlow.vscodeModels`    | `true`  | Offer the language models available in VS Code.                                              |
| `isarFlow.defaultShell`    | `auto`  | Shell for console blocks without `shell`: PowerShell on Windows, your login shell elsewhere. |
| `isarFlow.maxTokensPerRun` | `0`     | Stop a run after this many tokens. `0` means no limit.                                       |
| `isarFlow.confirmCommands` | `true`  | Ask before running console commands you have not approved.                                   |
| `isarFlow.historyLimit`    | `50`    | Runs kept per workflow.                                                                      |

## Troubleshooting

Run **Isar Flow: Show log** to see what happened during activation, model discovery and runs.

- _A model is missing_: run **Isar Flow: Refresh models** or **Isar Flow: Test model endpoint**. The base
  URL may end with or without `/v1`: when the plain URL answers 404, Isar Flow tries `<url>/v1`.
- _A command works in your terminal but not in a workflow_: set `shell` on the block, or change
  `isarFlow.defaultShell`.

## License

MIT
