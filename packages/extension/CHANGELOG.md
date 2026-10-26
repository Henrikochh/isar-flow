# Changelog

All notable changes to Isar Flow are listed here.

## 0.1.0

First release.

- **Agents**: configure agents in a form or as `*.agent.yaml` files, in the workspace (`.isarflow/agents/`) or
  for your user. Pick a model, a fallback list, a system prompt, tools and permissions, and try the agent
  in a chat next to the form.
- **Models**: use the language models VS Code offers (for example GitHub Copilot) and any OpenAI-compatible
  endpoint: LiteLLM, Ollama, vLLM, OpenRouter, OpenAI and others. Models are discovered with `GET /models`;
  API keys are kept in VS Code's secret storage.
- **Workflows**: build `*.workflow.yaml` files on a visual canvas with Agent, Console, Loop, If/Else, Break,
  Stop and Approval blocks. The canvas and the YAML stay in sync in both directions, and comments survive
  visual edits.
- **Runs**: run workflows from the canvas, the sidebar, a CodeLens or the Command Palette. Live block status
  on the canvas, console output mirrored to a terminal, approvals inline, and a history of recent runs.
- **Agent tools**: read, list and search files, view the git diff, edit and write files (undoable) and run
  commands. Every path stays inside the workspace folder; edits and commands are gated per agent
  (`none`, `ask` or `auto`).
- **Safety**: runs need a trusted workspace, loops need `maxIterations`, console commands are confirmed once
  per workflow version, an optional token budget stops runaway runs, and secrets are masked in run output.
- JSON Schemas for workflow and agent files, so the Red Hat YAML extension offers completion and validation.
