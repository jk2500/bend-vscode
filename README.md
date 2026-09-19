# Bend (2.0) Syntax for VS Code

Syntax highlighting for [Bend 2.0](https://bend-lang.com) — the parallel language with built-in proofs.

Faithfully ported from the official `bend2/docs/bend.sublime-syntax` in the [HigherOrderCO/Bend](https://github.com/HigherOrderCO/Bend) repository, extended for the law/proof workflow.

## Features

- All Bend 2.0 keywords: `def`, `law`, `type`, `match`, `case`, `import`, `for`, `exs`, `where`, `do`, `is`, `@unsafe`
- Law and proof support: `law`/`def` names highlighted, `{==}` proof token gets its own color, holes (`?name`) distinct
- `Nat` literals (`3n`), use-counts (`&0`/`&1`/`&2`), numbers, strings, char literals
- Capitalized type names (`U32`, `Nat`, `Bool`, `IO`, constructors) in type color
- `#` comments, full operator set (`->`, `=>`, `<-`, `<&>`, `++`, `<>`, …)
- Language configuration: comment toggling, bracket matching/auto-closing, colon-based indentation

## Why this exists

Every VS Code extension currently on the marketplace predates Bend 2.0 and cannot highlight
`law`, `exs`, or `import`. The official repo ships a Sublime syntax but no VS Code extension.
This port closes that gap. Source of truth: the official Sublime syntax file.

## Install

Search "Bend 2.0" in the VS Code extension marketplace, or install the `.vsix` manually:
`code --install-extension bend2-1.0.0.vsix`

MIT licensed. Bend is by HigherOrderCO; this extension is community-maintained.
