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

### Locals, signatures, law scaffolding (v2.2)
- **Rename and hover for locals**: parameters, `let`/pattern bindings — every
  use found via the checker's own lowered terms; a local rename is only
  applied if the result still loads through the real checker
- **Signature help** while typing a call: `U32.mul(a: U32, b: U32)` with the
  active parameter highlighted, types from the def's own type term
- **Code action on an open law**: "Bend: prove this law" scaffolds
  `def name(params): ?TODO` under the claim, with the law's `for` parameters
  (laws already filled by a def get no action)
- **Re-check on imported-file change**: editing a dependency re-checks open
  files automatically

### Full language features (v2.1) — from the real checker's symbol table
- **Completions**: every def/law/type/constructor visible from the current
  file — all of Base (400+ names), workspace defs, and module-qualified
  names (`L.foo` after `import ./LAWS.bend as L`), plus keywords and snippets
- **Hover**: a name's kind, signature and claim, rendered by Bend itself
  (`law one_plus_one :: {Nat.add(1n, 1n) == 2n : Nat}`)
- **Go to definition**: resolves through module aliases; a def that fills a
  law jumps to the law's claim
- **Find references / rename** across files, on top-level names
- **Document & workspace symbols** (outline, ⌘T), laws and defs distinguished
- **Semantic tokens**: exact coloring of defs, laws, types, constructors,
  parameters, variables and holes — replacing guess-based highlighting
- **Folding** by indentation blocks

### Diagnostics (v2.0)

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
