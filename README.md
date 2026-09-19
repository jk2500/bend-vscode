# Bend (2.0) for VS Code — Language Server

Language support for [Bend 2.0](https://bend-lang.com) — the parallel language with built-in proofs — powered by **the real Bend checker**.

## How it works

`server/server.ts` is a zero-dependency LSP server that imports the actual
toolchain (`~/.bend/current/bend2/bend.ts` — the same code the `bend` CLI
runs) and reports its structured results. Nothing about the language is
reimplemented: parse, types, laws, holes and locations all come from Bend
itself. The extension only spawns it with `bun` and maps results to squiggles.

If `bun` or the toolchain is missing, the extension falls back to v1-style
CLI-text checking.

## Features

- **Exact diagnostics as you type** (300 ms debounce): the checker's
  `expected / observed` message with the def name and local bindings, with a
  squiggle on the exact character range — not the whole line
- **Workflow states, not errors**: open claims (`?holes`) show as an
  information marker — "laws stated, not yet proven"; `@unsafe` terms show a
  warning
- **Checks in-memory buffers**: unsaved edits are checked through a shadow
  file beside the real one, so relative imports keep working; the file on
  disk is checked directly when clean
- **Per-file status bar**: All terms check / N errors / N open claims / unsafe
- **Commands**: `Bend: check this file now`, `Bend: restart language server`
- **Editor-agnostic**: any LSP client can run `bun server/server.ts`
- Syntax highlighting ported from the official `bend.sublime-syntax`, with
  `law`/`{==}`/hole support, and language configuration

## Requirements

- The [Bend](https://bend-lang.com) toolchain (`~/.bend`)
- [bun](https://bun.sh) (bundled with the Bend installer's default setup)

## Settings

- `bend2.server.enabled` — use the language server (default `true`); off = CLI-text fallback

## Development

```bash
code --install-extension bend2-2.0.0.vsix   # or launch the folder as an extension host
```

The server speaks plain LSP over stdio; to try it standalone:

```bash
bun server/server.ts   # then speak JSON-RPC on stdin/stdout
```

MIT licensed. Bend is by HigherOrderCO; this extension is community-maintained.
