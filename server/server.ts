#!/usr/bin/env bun
// server.ts - the Bend language server.
//
// Language intelligence comes from Bend itself: this process imports the
// real checker (~/.bend/current/bend2/bend.ts, the same code `bend` runs)
// and reports its structured results. Nothing about the language is
// reimplemented here; this file is only LSP protocol plumbing (zero deps).
//
// Phase 2: completions / hover / definition / references / rename /
// symbols / semantic tokens / folding, all derived from the checker's own
// Book (tlds, ctrs, term spans) — never from a reimplementation.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RpcPeer } from "../src/rpc.js";

const DEBOUNCE_MS = 300;
const CTX_LINES_MAX = 8;

// ---- locate the installed Bend toolchain (the real checker) ------------

function versCmp(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
}

function findBendTs(): string | null {
  const home = process.env.BEND_HOME || path.join(os.homedir(), ".bend");
  const cur = path.join(home, "current", "bend2", "bend.ts");
  if (fs.existsSync(cur)) return fs.realpathSync(cur);
  const app = path.join(home, "app");
  if (fs.existsSync(app)) {
    for (const ver of fs.readdirSync(app).filter((d) => /^\d/.test(d)).sort(versCmp).reverse()) {
      for (const hash of fs.readdirSync(path.join(app, ver))) {
        const p = path.join(app, ver, hash, "bend2", "bend.ts");
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

const BEND_TS = findBendTs();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Bend: any = BEND_TS ? await import(pathToFileURL(BEND_TS).href) : null;

// ---- helpers -------------------------------------------------------------

function posOf(src: string, off: number): { line: number; character: number } {
  const o = Math.max(0, Math.min(off, src.length));
  const line = src.slice(0, o).split("\n").length - 1;
  const character = o - (src.lastIndexOf("\n", o - 1) + 1);
  return { line, character };
}

function lineLen(src: string, line: number): number {
  const i = src.split("\n", line).join("\n").length + (line ? 1 : 0);
  const nl = src.indexOf("\n", i);
  return (nl < 0 ? src.length : nl) - i;
}

function rangeOf(spn: { src: string; beg: number; end: number } | undefined) {
  if (!spn) return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const start = posOf(spn.src, spn.beg);
  let end = posOf(spn.src, spn.end);
  if (end.line < start.line || (end.line === start.line && end.character <= start.character)) {
    const cap = lineLen(spn.src, start.line);
    end = { line: start.line, character: Math.min(start.character + 1, Math.max(cap, start.character)) };
  }
  return { start, end };
}

function safeShow(fn: () => string): string {
  try { return fn(); } catch { return "?"; }
}

// ---- workspace model built from the checker's own Book ------------------

type Occ = { k: string; kind: string; line: number; c0: number; c1: number };
type Decl = { kind: "def" | "law" | "type" | "import"; name: string; key: string | null;
  line: number; c0: number; c1: number };
type FileMeta = { path: string; ns: string; aliases: Record<string, string>;
  text: string; stripped: string; decls: Decl[] };
type Cache = { book: any; files: Map<string, FileMeta>; occ: Map<string, Occ[]> };

const caches = new Map<string, Cache>();

// mirror of bend.ts's import scan (organization only; semantics stay in Bend)
function readImports(text: string): { rel: string; alias: string | null }[] {
  const out: { rel: string; alias: string | null }[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (t && !t.startsWith("#") && !t.startsWith("import")) break; // header only
    const m = /^import\s+(\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*(?:#.*)?$/.exec(t);
    if (m) out.push({ rel: m[1], alias: m[2] || null });
  }
  return out;
}

function stripImports(text: string): string {
  return text.split("\n").map((l) => (/^\s*import\b/.test(l) ? "" : l)).join("\n");
}

// scan top-level decls and resolve each to its Book key
function scanDecls(text: string, ns: string, aliases: Record<string, string>): Decl[] {
  const decls: Decl[] = [];
  const lines = text.split("\n");
  const keyOf = (nm: string): string | null => {
    const parts = nm.split(".");
    if (parts.length > 1) {
      const target = aliases[parts[0]];
      if (target !== undefined) return target + "." + parts.slice(1).join(".");
      return nm; // dotted name with unknown alias: keep as written
    }
    return ns ? ns + "." + nm : nm;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s/.test(l)) continue; // top level is column 0
    let m = /^(def|law)\s+([A-Za-z_][\w.]*)/.exec(l);
    if (m) {
      const c0 = l.indexOf(m[2]);
      decls.push({ kind: m[1] as "def" | "law", name: m[2], key: keyOf(m[2]), line: i, c0, c1: c0 + m[2].length });
      continue;
    }
    m = /^type\s+([A-Za-z_]\w*)/.exec(l);
    if (m) {
      const c0 = l.indexOf(m[1]);
      decls.push({ kind: "type", name: m[1], key: keyOf(m[1]), line: i, c0, c1: c0 + m[1].length });
      continue;
    }
    m = /^import\s+(\S+)(?:\s+as\s+(\w+))?/.exec(l);
    if (m) {
      const shown = m[2] || m[1];
      const c0 = l.indexOf(shown, 6);
      decls.push({ kind: "import", name: shown, key: null, line: i, c0, c1: c0 + shown.length });
    }
  }
  return decls;
}

function loadFileMeta(filePath: string, ns: string, aliases: Record<string, string>,
  textOverride: string | null): FileMeta {
  const text = textOverride ?? fs.readFileSync(filePath, "utf8");
  return { path: filePath, ns, aliases, text, stripped: stripImports(text), decls: scanDecls(text, ns, aliases) };
}

// walk terms collecting occurrences with spans (works pre-validation;
// higher-order checked terms hide subterms behind closures)
function walkOcc(t: any, out: Occ[], depth = 0): void {
  if (!t || typeof t !== "object" || depth > 80) return;
  if (Array.isArray(t)) { for (const x of t) walkOcc(x, out, depth + 1); return; }
  if (typeof t === "function") return;
  if ((t.$ === "Ref" || t.$ === "Var" || t.$ === "PVar" || t.$ === "PCtr" || t.$ === "Hol")
    && t.s && t.s.end > t.s.beg) {
    const a = posOf(t.s.src, t.s.beg), b = posOf(t.s.src, t.s.end);
    out.push({ k: t.k, kind: t.$, line: a.line, c0: a.character, c1: b.character });
  }
  for (const v of Object.values(t)) if (typeof v === "object") walkOcc(v, out, depth + 1);
}

// (the direct approach): occurrences with their src, grouped per file
function occurrencesByFile(book: any, files: Map<string, FileMeta>): Map<string, Occ[]> {
  const srcToFile = new Map<string, string>();
  for (const [p, meta] of files) srcToFile.set(meta.stripped, p);
  const out = new Map<string, Occ[]>();
  const emit = (k: string, kind: string, src: string, beg: number, end: number): void => {
    const p = srcToFile.get(src);
    if (p === undefined) return;
    const a = posOf(src, beg), b = posOf(src, end);
    const arr = out.get(p) ?? [];
    arr.push({ k, kind, line: a.line, c0: a.character, c1: b.character });
    out.set(p, arr);
  };
  const walk = (t: any, depth = 0): void => {
    if (!t || typeof t !== "object" || depth > 80) return;
    if (Array.isArray(t)) { for (const x of t) walk(x, depth + 1); return; }
    if (typeof t === "function") return;
    if ((t.$ === "Ref" || t.$ === "Var" || t.$ === "PVar" || t.$ === "PCtr" || t.$ === "Hol")
      && t.s && t.s.end > t.s.beg) emit(t.k, t.$, t.s.src, t.s.beg, t.s.end);
    for (const v of Object.values(t)) if (typeof v === "object") walk(v, depth + 1);
  };
  for (const tld of Object.values<any>(book.tlds)) {
    if (tld.b === true) continue;
    if (tld.$ === "Def") { if (tld.T) walk(tld.T); if (tld.v) walk(tld.v); if (tld.e) walk(tld.e); }
    if (tld.$ === "ADT") { walk(tld.T); for (const c of tld.c) walk(c.T); }
  }
  return out;
}

// ---- documents -----------------------------------------------------------

type Doc = { text: string; version: number; timer: any; running: boolean;
  pending: boolean; checked: number; last: number };

const docs = new Map<string, Doc>();

function docOf(uri: string): Doc | undefined { return docs.get(uri); }

function schedule(uri: string, delay: number): void {
  const doc = docOf(uri);
  if (!doc) return;
  if (doc.timer) clearTimeout(doc.timer);
  doc.timer = setTimeout(() => { doc.timer = null; void check(uri); }, delay);
}

function materialize(uri: string, text: string): { file: string; shadow: string | null } {
  let file: string | null = null;
  try {
    if (uri.startsWith("file:")) {
      file = fileURLToPath(uri);
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) {
        return { file, shadow: null };
      }
    }
  } catch { /* fall through to a shadow file */ }
  const dir = (file && fs.existsSync(path.dirname(file))) ? path.dirname(file) : os.tmpdir();
  const base = file ? path.basename(file, ".bend") : "untitled";
  const shadow = path.join(dir, "." + base + ".bendlsp-check.bend");
  fs.writeFileSync(shadow, text, "utf8");
  return { file: shadow, shadow };
}

function report(uri: string, version: number, diagnostics: any[],
  status: { errors: number; todos: number; unsafe: number; ok: boolean }): void {
  peer.notify("textDocument/publishDiagnostics", { uri, version, diagnostics });
  peer.notify("bend/status", { uri, version, ...status });
}

async function check(uri: string): Promise<void> {
  const doc = docOf(uri);
  if (!doc || doc.running) { if (doc) doc.pending = true; return; }
  doc.running = true;
  doc.pending = false;
  const version = doc.version;
  const text = doc.text;
  let shadow: string | null = null;
  try {
    if (!Bend) {
      report(uri, version, [{ range: rangeOf(undefined), severity: 1, source: "bend",
        message: "bend toolchain not found (expected ~/.bend/current/bend2/bend.ts)." }],
        { errors: 1, todos: 0, unsafe: 0, ok: false });
      return;
    }
    let file: string;
    ({ file, shadow } = materialize(uri, text));
    const diagnostics: any[] = [];
    let status = { errors: 0, todos: 0, unsafe: 0, ok: true };
    const book = Bend.book_nil();
    let loaded = false;
    try {
      await Bend.book_load(book, file, "", new Map());
      loaded = true;
      // cache occurrences BEFORE validation (checked terms hide subterms)
      const entryText = shadow ? text : null;
      const files = importGraph(file, entryText);
      caches.set(uri, { book, files, occ: occurrencesByFile(book, files) });
      Bend.book_valid(book, 0);
    } catch (e: any) {
      if (loaded) caches.set(uri, { book, files: importGraph(file, shadow ? text : null), occ: new Map() });
      status = { ...status, errors: 1, ok: false };
      const err = e;
      const todoM = /^Error: (\d+) TODOs?/.exec(String(e));
      if (err && err.$ === "Err") {
        const parts: string[] = [];
        const bnd = Bend.ctx_scope(err.ctx);
        if (err.obs !== undefined) {
          parts.push("expected: " + safeShow(() => Bend.expr_show(err.bok, err.exp, bnd)));
          parts.push("observed: " + safeShow(() => Bend.expr_show(err.bok, err.obs, bnd)));
        } else {
          parts.push(safeShow(() => Bend.expr_show(err.bok, err.exp, bnd)));
        }
        if (err.def !== undefined) parts.push("in def: " + err.def);
        try {
          const anns = Bend.pmap_to_array(err.ctx).sort((a: any, b: any) => a[0] - b[0]);
          if (anns.length) {
            parts.push("", "locals:");
            for (const [i, a] of anns.slice(0, CTX_LINES_MAX)) {
              parts.push("  " + a.k + ": "
                + safeShow(() => Bend.term_show(Bend.term_lower(Bend.term_snf(err.bok, a.T), i), -1, bnd.slice(0, i))));
            }
            if (anns.length > CTX_LINES_MAX) parts.push("  … " + (anns.length - CTX_LINES_MAX) + " more");
          }
        } catch { /* context is optional */ }
        diagnostics.push({ range: rangeOf(err.spn), severity: 1, source: "bend", message: parts.join("\n") });
      } else if (todoM) {
        const n = parseInt(todoM[1], 10);
        status = { errors: 0, todos: n, unsafe: 0, ok: false };
        diagnostics.push({ range: rangeOf(undefined), severity: 3, source: "bend",
          message: n + " open claim" + (n === 1 ? "" : "s") + " (holes) — laws stated, not yet proven." });
      } else {
        diagnostics.push({ range: rangeOf(undefined), severity: 1, source: "bend", message: String(e) });
      }
      report(uri, version, diagnostics, status);
      return;
    }
    const todos = (book.hols ?? 0) + (book.open ?? 0);
    if (todos > 0) {
      status = { errors: 0, todos, unsafe: 0, ok: true };
      diagnostics.push({ range: rangeOf(undefined), severity: 3, source: "bend",
        message: todos + " open claim" + (todos === 1 ? "" : "s") + " (holes) — not yet a valid proof." });
    } else {
      const unsafe = Object.values(book.tlds).filter((t: any) => t && t.$ === "Def" && t.u === true).length;
      if (unsafe > 0) {
        status = { errors: 0, todos: 0, unsafe, ok: true };
        diagnostics.push({ range: rangeOf(undefined), severity: 2, source: "bend",
          message: unsafe + " term" + (unsafe === 1 ? "" : "s") + " annotated as unsafe — well-typed, but may contain logical paradoxes." });
      }
    }
    report(uri, version, diagnostics, status);
  } catch (e: any) {
    peer.notify("window/logMessage", { type: 1, message: "bend-lsp check failed: " + String((e && e.stack) || e) });
  } finally {
    if (shadow) { try { fs.unlinkSync(shadow); } catch { /* best effort */ } }
    doc.running = false;
    if (doc.pending && doc.version !== version) void check(uri);
    else doc.pending = false;
  }
}

// mirror of bend.ts's namespace join: posix.join normalizes './' away
function nsJoin(ns: string, rel: string): string {
  return path.posix.join(path.posix.dirname(ns === "" ? "." : ns), rel).replace(/\.bend$/, "");
}

// import graph with namespaces, mirroring bend.ts's own resolution
function importGraph(entryPath: string, entryText: string | null): Map<string, FileMeta> {
  const files = new Map<string, FileMeta>();
  const nsOf = (ns: string, rel: string): string =>
    path.posix.join(path.posix.dirname(ns === "" ? "." : ns), rel).replace(/\.bend$/, "");
  const visit = (p: string, ns: string): void => {
    const real = fs.realpathSync(p);
    if (files.has(real)) return;
    const isEntry = real === fs.realpathSync(entryPath);
    const text = isEntry && entryText !== null ? entryText : fs.readFileSync(real, "utf8");
    files.set(real, { path: real, ns, aliases: {}, text, stripped: stripImports(text), decls: [] });
    for (const im of readImports(text)) {
      if (im.rel === "Base" || im.rel.startsWith("0x")) continue;
      if (!im.alias) continue;
      visit(path.resolve(path.dirname(p), im.rel), nsOf(ns, im.rel));
    }
  };
  try { visit(entryPath, ""); } catch { /* partial graph is fine */ }
  for (const meta of files.values()) {
    meta.aliases = aliasesOf(meta, files);
    meta.decls = scanDecls(meta.text, meta.ns, meta.aliases);
  }
  return files;
}

function aliasesOf(meta: FileMeta, _files: Map<string, FileMeta>): Record<string, string> {
  const al: Record<string, string> = {};
  for (const im of readImports(meta.text)) {
    if (im.alias) al[im.alias] = nsJoin(meta.ns, im.rel);
  }
  return al;
}

// ---- Phase 2: features over the cached Book ------------------------------

function cacheOf(uri: string): Cache | undefined {
  return caches.get(uri) ?? [...caches.entries()].find(([, c]) => c.files.has(uriFile(uri)))?.[1];
}

function uriFile(uri: string): string | null {
  try { return uri.startsWith("file:") ? fs.realpathSync(fileURLToPath(uri)) : null; }
  catch { return null; }
}

// resolve the word at a position to a Book key
function keyAt(uri: string, line: number, ch: number): { key: string; occ: Occ; meta: FileMeta } | null {
  const cache = cacheOf(uri);
  if (!cache) return null;
  const file = uriFile(uri);
  if (!file) return null;
  const meta = cache.files.get(file);
  const occs = cache.occ.get(file) ?? [];
  const occ = occs.find((o) => o.line === line && ch >= o.c0 && ch <= o.c1);
  if (occ && meta) return { key: occ.k, occ, meta };
  // fall back: decl site?
  if (meta) {
    for (const d of meta.decls) {
      if (d.key && d.line === line && ch >= d.c0 && ch <= d.c1) return { key: d.key, occ: { k: d.key, kind: "decl", line, c0: d.c0, c1: d.c1 }, meta };
    }
  }
  return null;
}

function declSitesOfKey(key: string): { uri: string; range: any; kind: string }[] {
  const out: { uri: string; range: any; kind: string }[] = [];
  for (const [, cache] of caches) {
    for (const [p, meta] of cache.files) {
      for (const d of meta.decls) {
        if (d.key === key) {
          out.push({ uri: pathToFileURL(p).href, kind: d.kind,
            range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } } });
        }
      }
    }
  }
  return out;
}

// a def that fills a law shares its key: jumping to the law reads better
function declSiteOfKey(key: string): { uri: string; range: any } | null {
  const sites = declSitesOfKey(key);
  return sites.find((s) => s.kind === "law") ?? sites[0] ?? null;
}

function hoverOf(key: string, book: any): string | null {
  const tld = book.tlds[key];
  const ctr = book.ctrs[key];
  if (tld) {
    const kind = tld.$ === "ADT" ? "type" : "def";
    const t = safeShow(() => Bend.term_show(Bend.term_lower(tld.T), -1, []));
    const base = tld.b === true ? " — Base" : "";
    const law = tld.$ === "Def" && tld.v === null ? " (open law)" : "";
    return "```bend\n" + kind + " " + key + base + law + "\n  :: " + t + "\n```";
  }
  if (ctr) {
    const t = safeShow(() => Bend.term_show(Bend.term_lower(ctr.T), -1, []));
    return "```bend\nconstructor " + key + " (arity " + ctr.n + ")\n  :: " + t + "\n```";
  }
  return null;
}

// names reachable from a file, in user-facing form
function completionsIn(meta: FileMeta, book: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(book.tlds)) {
    let shown: string | null = null;
    if (meta.ns !== "" && key.startsWith(meta.ns + ".")) {
      shown = key.slice(meta.ns.length + 1); // names of this file's own module
    } else {
      for (const [alias, target] of Object.entries(meta.aliases)) {
        if (key.startsWith(target + ".")) { shown = alias + key.slice(target.length); break; }
      }
    }
    if (shown === null && !key.includes("/")) shown = key; // global / Base name as written
    if (!shown || seen.has(shown)) continue;
    seen.add(shown);
    const tld = book.tlds[key];
    const isLaw = tld.$ === "Def" && tld.v === null;
    out.push({ label: shown,
      kind: tld.$ === "ADT" ? 23 /* Struct */ : 3 /* Function */,
      detail: (tld.b === true ? "Base · " : "") + (isLaw ? "law" : "def") + " :: "
        + safeShow(() => Bend.term_show(Bend.term_lower(tld.T), -1, []).slice(0, 160)) });
  }
  for (const key of Object.keys(book.ctrs)) {
    if (!seen.has(key)) {
      seen.add(key);
      const c = book.ctrs[key];
      out.push({ label: key, kind: 20 /* EnumMember */, detail: "constructor, arity " + c.n });
    }
  }
  return out;
}

const KEYWORDS = ["def", "law", "type", "match", "case", "do", "return", "import",
  "as", "for", "exs", "where", "is", "Type", "Data", "Kind", "Quant", "@unsafe"];

const SNIPPETS = [
  { label: "def", insert: "def ${1:name}(${2:x: T}) -> ${3:U32}:\n  $0" },
  { label: "law", insert: "law ${1:name}:\n  for ${2:x}: ${3:T}\n  ${4:claim}" },
  { label: "type", insert: "type ${1:Name} is Data:\n  ${2:K}{x: ${3:T}}" },
  { label: "match", insert: "match ${1:x}:\n  case ${2:K}:\n    $0" },
  { label: "do", insert: "do ${1:IO}<${2:Unit}>:\n  $0" },
];

// ---- semantic tokens ------------------------------------------------------

const TOKEN_TYPES = ["function", "law", "type", "constructor", "variable",
  "parameter", "hole", "module", "keyword"];

function semanticTokensOf(uri: string): { data: number[] } | null {
  const cache = cacheOf(uri);
  const file = uriFile(uri);
  if (!cache || !file) return null;
  const meta = cache.files.get(file);
  const occs = cache.occ.get(file) ?? [];
  if (!meta) return null;
  const book = cache.book;
  const toks: { line: number; c0: number; len: number; t: number }[] = [];
  const push = (line: number, c0: number, len: number, t: number) => {
    if (len > 0) toks.push({ line, c0, len, t });
  };
  for (const d of meta.decls) {
    if (d.kind === "import") push(d.line, d.c0, d.c1 - d.c0, 7);
    else if (d.kind === "type") push(d.line, d.c0, d.c1 - d.c0, 2);
    else {
      const tld = d.key ? book.tlds[d.key] : undefined;
      const isLaw = tld && tld.$ === "Def" && tld.v === null;
      push(d.line, d.c0, d.c1 - d.c0, isLaw ? 1 : 0);
    }
  }
  for (const o of occs) {
    const t = o.kind === "PCtr" || (o.kind === "Ref" && book.ctrs[o.k] !== undefined) ? 3
      : o.kind === "Var" ? 4 : o.kind === "PVar" ? 5
      : o.kind === "Hol" ? 6 : o.kind === "Ref" ? 0 : 4;
    push(o.line, o.c0, o.c1 - o.c0, t);
  }
  toks.sort((a, b) => (a.line - b.line) || (a.c0 - b.c0));
  const data: number[] = [];
  let pl = 0, pc = 0;
  for (const t of toks) {
    data.push(t.line - pl, t.c0 - (t.line === pl ? pc : 0), t.len, t.t, 0);
    pl = t.line; pc = t.c0;
  }
  return { data };
}

// ---- folding (indentation blocks — Bend is layout-scoped) ----------------

function foldingOf(uri: string): any[] | null {
  const doc = docOf(uri);
  const cache = cacheOf(uri);
  if (!doc || !cache) return null;
  const file = uriFile(uri);
  const meta = file ? cache.files.get(file) : undefined;
  const text = meta ? meta.text : doc.text;
  const lines = text.split("\n");
  const out: any[] = [];
  const stack: { line: number; ind: number }[] = [];
  let lastNonBlank = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = l.length - l.trimStart().length;
    while (stack.length && stack[stack.length - 1].ind >= ind) {
      const s = stack.pop()!;
      if (i - 1 > s.line) out.push({ startLine: s.line, endLine: i - 1, kind: "region" });
    }
    stack.push({ line: i, ind });
    lastNonBlank = i;
  }
  while (stack.length) {
    const s = stack.pop()!;
    if (lastNonBlank > s.line) out.push({ startLine: s.line, endLine: lastNonBlank, kind: "region" });
  }
  return out;
}

// ---- LSP plumbing --------------------------------------------------------

const peer = new RpcPeer(process.stdin, process.stdout);

peer.notificationHandler = (method: string, params: any) => {
  switch (method) {
    case "initialized": return;
    case "textDocument/didOpen":
      docs.set(params.textDocument.uri, { text: params.textDocument.text,
        version: params.textDocument.version, timer: null, running: false,
        pending: false, checked: 0, last: 0 });
      schedule(params.textDocument.uri, 0);
      return;
    case "textDocument/didChange": {
      const doc = docOf(params.textDocument.uri);
      if (!doc) return;
      doc.version = params.textDocument.version;
      const last = params.contentChanges[params.contentChanges.length - 1];
      if (last && last.text !== undefined) doc.text = last.text; // full sync
      schedule(params.textDocument.uri, DEBOUNCE_MS);
      return;
    }
    case "textDocument/didSave": schedule(params.textDocument.uri, 0); return;
    case "textDocument/didClose":
      docs.delete(params.textDocument.uri);
      caches.delete(params.textDocument.uri);
      peer.notify("textDocument/publishDiagnostics", { uri: params.textDocument.uri, diagnostics: [] });
      return;
    case "exit": process.exit(0); return;
    default: return;
  }
};

peer.requestHandler = async (method: string, params: any) => {
  switch (method) {
    case "initialize":
      peer.notify("window/logMessage", { type: 3, message:
        "bend-lsp: checker " + (BEND_TS ? BEND_TS : "NOT FOUND") });
      return { capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: true },
        completionProvider: { triggerCharacters: ["."], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        foldingRangeProvider: true,
        semanticTokensProvider: {
          legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] },
          full: true,
        },
      }, serverInfo: { name: "bend-lsp" } };
    case "shutdown": return null;
    case "bend/checkNow": schedule(params.uri, 0); return null;
    case "textDocument/completion": {
      const uri = params.textDocument.uri;
      const cache = cacheOf(uri);
      const file = uriFile(uri);
      if (!cache || !file) return KEYWORDS.map((k) => ({ label: k, kind: 14 }))
        .concat(SNIPPETS.map((s) => ({ label: s.label, kind: 15, insert: s.insert })));
      const meta = cache.files.get(file)!;
      const pos = params.position;
      const line = docOf(uri)?.text.split("\n")[pos.line] ?? "";
      const dotPrefix = /^([A-Za-z_][\w]*)\.\w*$/.exec(line.slice(0, pos.character));
      let items = completionsIn(meta, cache.book);
      if (dotPrefix) {
        const prefix = dotPrefix[1] + ".";
        items = items.filter((i: any) => i.label.startsWith(prefix));
      }
      return items.concat(KEYWORDS.map((k) => ({ label: k, kind: 14 })))
        .concat(SNIPPETS.map((s) => ({ label: s.label, kind: 15, insert: s.insert })));
    }
    case "textDocument/hover": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      const cache = cacheOf(params.textDocument.uri)!;
      const h = hoverOf(at.key, cache.book);
      return h ? { contents: { kind: "markdown", value: h } } : null;
    }
    case "textDocument/definition": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      const site = declSiteOfKey(at.key);
      return site ? [site] : null;
    }
    case "textDocument/references": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      const out: any[] = [];
      for (const [uri, cache] of caches) {
        void uri;
        for (const [p, occs] of cache.occ) {
          for (const o of occs) {
            if (o.k === at.key) out.push({ uri: pathToFileURL(p).href,
              range: { start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } } });
          }
        }
      }
      if (params.context && params.context.includeDeclaration) {
        for (const s of declSitesOfKey(at.key)) out.push(s);
      }
      return out;
    }
    case "textDocument/prepareRename": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      // locals (de Bruijn) need scope analysis; only top-level names for now
      if (at.occ.kind === "Var" || at.occ.kind === "PVar") return null;
      const cache = cacheOf(params.textDocument.uri)!;
      if (!cache.book.tlds[at.key] && !cache.book.ctrs[at.key]) return null;
      return { range: { start: { line: at.occ.line, character: at.occ.c0 },
        end: { line: at.occ.line, character: at.occ.c1 } }, placeholder: at.key };
    }
    case "textDocument/rename": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      const newName: string = params.newName;
      const changes: Record<string, any[]> = {};
      const add = (uri: string, line: number, c0: number, c1: number) => {
        (changes[uri] = changes[uri] ?? []).push(
          { range: { start: { line, character: c0 }, end: { line, character: c1 } }, newText: newName });
      };
      let count = 0;
      for (const [, cache] of caches) {
        for (const [p, occs] of cache.occ) {
          for (const o of occs) {
            if (o.k === at.key && o.kind !== "Var" && o.kind !== "PVar") {
              add(pathToFileURL(p).href, o.line, o.c0, o.c1);
              count++;
            }
          }
        }
        for (const [p, meta] of cache.files) {
          for (const d of meta.decls) {
            if (d.key === at.key) {
              add(pathToFileURL(p).href, d.line, d.c0, d.c1);
              count++;
            }
          }
        }
      }
      return count > 0 ? { changes } : null;
    }
    case "textDocument/documentSymbol": {
      const cache = cacheOf(params.textDocument.uri);
      const file = uriFile(params.textDocument.uri);
      if (!cache || !file) return [];
      const meta = cache.files.get(file);
      if (!meta) return [];
      return meta.decls.map((d) => ({
        name: d.name,
        kind: d.kind === "type" ? 23 : d.kind === "import" ? 2 : (cache.book.tlds[d.key!]?.$ === "Def"
          && cache.book.tlds[d.key!].v === null ? 12 : 12),
        location: { uri: params.textDocument.uri,
          range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } } },
      }));
    }
    case "workspace/symbol": {
      const q: string = (params.query || "").toLowerCase();
      const out: any[] = [];
      for (const [uri, cache] of caches) {
        void uri;
        for (const [p, meta] of cache.files) {
          for (const d of meta.decls) {
            if (d.kind === "import") continue;
            if (q && !d.name.toLowerCase().includes(q)) continue;
            out.push({ name: d.name, kind: d.kind === "type" ? 23 : 12,
              location: { uri: pathToFileURL(p).href,
                range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } } } });
          }
        }
      }
      return out;
    }
    case "textDocument/foldingRange":
      return foldingOf(params.textDocument.uri);
    case "textDocument/semanticTokens/full":
      return semanticTokensOf(params.textDocument.uri);
    default: throw new Error("MethodNotFound: " + method);
  }
};

process.stdin.resume();
