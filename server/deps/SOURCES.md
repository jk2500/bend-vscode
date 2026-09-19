# Vendored Bend checker

- `bend2/bend.ts` and `bend2/base.bend` come from the official repository
  https://github.com/bendlang/bend at tag `v2.0.16` (MIT, HigherOrderCO).
- Used as a fallback when the installed toolchain does not expose its
  sources (the 2.0.16+ installer ships a compiled binary only).
- When `~/.bend` has an importable `bend.ts` (or `BEND_LSP_BEND_TS` is set),
  the server prefers the user's own checker over this copy.
