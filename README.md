# Isar Flow

AI agents and YAML workflows for VS Code — built visually, stored as plain YAML.

See [the design spec](docs/superpowers/specs/2026-10-25-isar-flow-design.md) and the
[implementation plan](docs/superpowers/plans/2026-10-25-isar-flow.md).

## Development

```bash
npm install
npm run build      # webview bundle + extension bundle
npm test           # unit, contract and component tests (Vitest)
npm run typecheck
npm run lint
```

Press `F5` in VS Code with `packages/extension` open to launch an Extension Development Host.
