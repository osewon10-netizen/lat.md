# traps — executable incident table (test fixture)

Known error signatures and their fixes; the PostToolUseFailure hook matches
these against failed commands.

## trap: uv-extras-uninstalled

- signature: `Failed to spawn: pytest`
- fix: A bare `uv sync` uninstalls pytest+ruff (they are extras) — run `uv sync --extra dev` (PA-1286).

## trap: bad-regex-skipped

- signature: `[unclosed`
- fix: this entry has an invalid regex and must be skipped, never fatal.
