# Contributing

## Running it

```bash
npm install
npm run check          # typecheck + lint + unit tests
npm run test:integration
npm run build
```

## Ground rules

- `src/core/**` stays free of `vscode` imports and of side effects that are not passed in. That is what makes it testable.
- **Tests never touch a real `~/.claude`.** Every test builds its own `CLAUDE_CONFIG_DIR` in a temporary directory (see `src/test/unit/fixtures.ts`).
- The backup path copies **bytes**. Parsing is only ever used for metadata and for finding a safe cut point, so that a change in the provider's internal format degrades the extras and never the copy.
- Anything that writes outside the vault needs: a previous byte-for-byte copy, an explicit confirmation, and a way back.

## Reporting bugs

Include your OS, VS Code version, extension version and the SessionKeeper output channel (`SessionKeeper: Show log`). Never paste transcript content — it may contain credentials.
