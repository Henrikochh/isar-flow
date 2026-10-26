# Changelog

All notable changes to Isar Flow are listed here.

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
