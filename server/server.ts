#!/usr/bin/env bun
// server.ts - the Bend language server.
//
// Language intelligence comes from Bend itself: this process imports the
// real checker (~/.bend/current/bend2/bend.ts, the same code `bend` runs)
// and reports its structured results. Nothing about the language is
// reimplemented here; this file is only LSP protocol plumbing (zero deps).
//
// v2.2: locals (rename/hover), signature help, law-scaffold code action,
// term_lower-based occurrence walk (the parsed tree hides bodies behind
// closures until lowered).

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

function rangeOf(spn: { src: string; beg: number; end: number } | undefined) {
  if (!spn) return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const start = posOf(spn.src, spn.beg);
  let end = posOf(spn.src, spn.end);
  if (end.line < start.line || (end.line === start.line && end.character <= start.character)) {
    const cap = (spn.src.split("\n")[start.line] ?? "").length;
    end = { line: start.line, character: Math.min(start.character + 1, Math.max(cap, start.character)) };
  }
  return { start, end };
}

function safeShow(fn: () => string): string {
  try { return fn(); } catch { return "?"; }
}

// the def's parameter list, from its own type term (tele)
function teleOf(T: any): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  let t: any = T;
  try { t = Bend.term_lower(T); } catch { /* keep raw if it cannot lower */ }
  while (t && t.$ === "All") {
    out.push({ name: t.k, type: safeShow(() => Bend.term_show(Bend.term_lower(t.A), -1, [])) });
    t = t.B; // lowered: bodies are plain terms, the chain is walkable
  }
  return out;
}

// ---- workspace model built from the checker's own Book ------------------

type Occ = { k: string; kind: string; line: number; c0: number; c1: number };
type Decl = { kind: "def" | "law" | "type" | "import"; name: string; key: string | null;
  line: number; c0: number; c1: number };
type FileMeta = { path: string; ns: string; aliases: Record<string, string>;
  text: string; stripped: string; decls: Decl[] };
type Cache = { book: any; files: Map<string, FileMeta>; occ: Map<string, Occ[]> };

const caches = new Map<string, Cache>();

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

// mirror of bend.ts's namespace join: posix.join normalizes './' away
function nsJoin(ns: string, rel: string): string {
  return path.posix.join(path.posix.dirname(ns === "" ? "." : ns), rel).replace(/\.bend$/, "");
}

function aliasesOf(text: string, ns: string): Record<string, string> {
  const al: Record<string, string> = {};
  for (const im of readImports(text)) {
    if (im.alias) al[im.alias] = nsJoin(ns, im.rel);
  }
  return al;
}

function importGraph(entryPath: string, entryText: string | null): Map<string, FileMeta> {
  const files = new Map<string, FileMeta>();
  const visit = (p: string, ns: string): void => {
    const real = fs.realpathSync(p);
    if (files.has(real)) return;
    const isEntry = real === fs.realpathSync(entryPath);
    const text = isEntry && entryText !== null ? entryText : fs.readFileSync(real, "utf8");
    files.set(real, { path: real, ns, aliases: {}, text, stripped: stripImports(text), decls: [] });
    for (const im of readImports(text)) {
      if (im.rel === "Base" || im.rel.startsWith("0x") || !im.alias) continue;
      visit(path.resolve(path.dirname(p), im.rel), nsJoin(ns, im.rel));
    }
  };
  try { visit(entryPath, ""); } catch { /* partial graph is fine */ }
  for (const meta of files.values()) {
    meta.aliases = aliasesOf(meta.text, meta.ns);
    meta.decls = scanDecls(meta.text, meta.ns, meta.aliases);
  }
  return files;
}

// sub-span of each bound name inside a binder span ("+m1" -> name at 1..3)
function binderNameSpans(k: string | string[], s: any): { name: string; beg: number; end: number }[] {
  if (!s) return [];
  const names = Array.isArray(k) ? k : [k];
  const txt: string = s.src.slice(s.beg, s.end);
  const out: { name: string; beg: number; end: number }[] = [];
  let at = 0;
  for (const nm of names) {
    const idx = txt.indexOf(nm, at);
    if (idx < 0) return []; // can't locate: caller must refuse
    out.push({ name: nm, beg: s.beg + idx, end: s.beg + idx + nm.length });
    at = idx + nm.length;
  }
  return out;
}

// occurrences with their src, grouped per file. Walks LOWERED terms: the
// parsed tree keeps bodies behind closures until term_lower applies them.
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
    if (!t || typeof t !== "object" || depth > 90) return;
    if (Array.isArray(t)) { for (const x of t) walk(x, depth + 1); return; }
    if (typeof t === "function") return;
    if (t.s && t.s.end > t.s.beg) {
      if (t.$ === "Ref" || t.$ === "PCtr") {
        emit(t.k, t.$, t.s.src, t.s.beg, t.s.end);
      } else if (t.$ === "Var" || t.$ === "PVar" || t.$ === "Hol") {
        // span may include a quantifier prefix ("+m1"): trim to the name
        const txt = t.s.src.slice(t.s.beg, t.s.end);
        const idx = txt.lastIndexOf(t.k);
        if (idx >= 0 && t.k.length > 0) emit(t.k, t.$, t.s.src, t.s.beg + idx, t.s.beg + idx + t.k.length);
        else emit(t.k, t.$, t.s.src, t.s.beg, t.s.end);
      } else if (t.$ === "Lam" || t.$ === "All" || t.$ === "Let") {
        for (const b of binderNameSpans(t.k, t.s)) emit(b.name, "binder", t.s.src, b.beg, b.end);
      }
    }
    for (const v of Object.values(t)) if (typeof v === "object") walk(v, depth + 1);
  };
  for (const tld of Object.values<any>(book.tlds)) {
    if (tld.b === true) continue; // Base: not part of this workspace
    try {
      if (tld.$ === "Def") {
        if (tld.T) walk(Bend.term_lower(tld.T));
        if (tld.v) walk(Bend.term_lower(tld.v));
        if (tld.e) walk(Bend.term_lower(tld.e));
      } else if (tld.$ === "ADT") {
        walk(Bend.term_lower(tld.T));
        for (const c of tld.c) walk(Bend.term_lower(c.T));
      }
    } catch { /* a def that cannot lower still contributes the others */ }
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
      const entryText = shadow ? text : null;
      const files = importGraph(file, entryText);
      caches.set(uri, { book, files, occ: occurrencesByFile(book, files) });
      Bend.book_valid(book, 0);
    } catch (e: any) {
      // the cache built before book_valid (occurrences included) stays: a
      // file with a type error still has complete structure for navigation
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

// ---- Phase 2 features over the cached Book ------------------------------

function cacheOf(uri: string): Cache | undefined {
  return caches.get(uri) ?? [...caches.entries()].find(([, c]) => c.files.has(uriFile(uri)))?.[1];
}

function uriFile(uri: string): string | null {
  try { return uri.startsWith("file:") ? fs.realpathSync(fileURLToPath(uri)) : null; }
  catch { return null; }
}

function keyAt(uri: string, line: number, ch: number): { key: string; occ: Occ; meta: FileMeta } | null {
  const cache = cacheOf(uri);
  if (!cache) return null;
  const file = uriFile(uri);
  if (!file) return null;
  const meta = cache.files.get(file);
  const occs = cache.occ.get(file) ?? [];
  const occ = occs.find((o) => o.line === line && ch >= o.c0 && ch <= o.c1
    && o.kind !== "Var" && o.kind !== "PVar" && o.kind !== "binder");
  if (occ && meta) return { key: occ.k, occ, meta };
  if (meta) {
    for (const d of meta.decls) {
      if (d.key && d.line === line && ch >= d.c0 && ch <= d.c1) return { key: d.key, occ: { k: d.key, kind: "decl", line, c0: d.c0, c1: d.c1 }, meta };
    }
  }
  return null;
}

// the local at a position (Var/PVar use or binder), and its enclosing def
function localAt(uri: string, line: number, ch: number):
  { name: string; defKey: string | null; occ: Occ } | null {
  const cache = cacheOf(uri);
  const file = uriFile(uri);
  if (!cache || !file) return null;
  const meta = cache.files.get(file);
  if (!meta) return null;
  const occs = cache.occ.get(file) ?? [];
  const occ = occs.find((o) => (o.kind === "Var" || o.kind === "PVar" || o.kind === "binder")
    && o.line === line && ch >= o.c0 && ch <= o.c1);
  if (!occ) return null;
  let defKey: string | null = null;
  let best = -1;
  for (const d of meta.decls) {
    if (d.key && d.line <= line && d.line > best) { best = d.line; defKey = d.key; }
  }
  return { name: occ.k, defKey, occ };
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
    const tele = tld.$ === "Def" && tld.v !== null && tld.T
      ? teleOf(tld.T).map((p) => p.name + ": " + p.type).join(", ") : null;
    return "```bend\n" + kind + " " + key + base + law + "\n  :: " + t + "\n```"
      + (tele ? "\n```bend\n(" + tele + ")\n```" : "");
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
      : o.kind === "Var" ? 4 : o.kind === "PVar" || o.kind === "binder" ? 5
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

// ---- signature help -------------------------------------------------------

// find the innermost unclosed '(' before the cursor and the callee name
function callAt(text: string, line: number, ch: number):
  { name: string; argIndex: number } | null {
  const upto = text.split("\n").slice(0, line + 1).join("\n").slice(0,
    text.split("\n", line).join("\n").length + (line ? 1 : 0) + ch);
  let depth = 0;
  let argIdx = 0;
  for (let i = upto.length - 1; i >= 0; i--) {
    const c = upto[i];
    if (c === ")" || c === "}" || c === "]") depth++;
    else if (c === "(" || c === "{" || c === "[") {
      if (depth === 0 && c === "(") {
        const before = upto.slice(0, i);
        const m = /([A-Za-z_][\w.]*)\s*$/.exec(before);
        if (!m) return null;
        return { name: m[1], argIndex: argIdx };
      }
      depth--;
    } else if (depth === 0 && c === ",") argIdx++;
    else if (depth === 0 && (c === "\"" || c === "#")) {
      // naive: stop scanning at a string or comment boundary going backwards
      const lineTxt = text.split("\n")[line] ?? "";
      if (c === "#" && upto.slice(0, i).split("\n").pop() === lineTxt.slice(0, i - (upto.length - lineTxt.length))) return null;
    }
  }
  return null;
}

function signatureHelpFor(uri: string, line: number, ch: number): any | null {
  const doc = docOf(uri);
  const cache = cacheOf(uri);
  if (!doc || !cache) return null;
  const call = callAt(doc.text, line, ch);
  if (!call) return null;
  // resolve the callee to a book key: occurrence at its position, or by name
  const file = uriFile(uri);
  const meta = file ? cache.files.get(file) : undefined;
  if (!file || !meta) return null;
  const before = doc.text.split("\n", line).join("\n").length + (line ? 1 : 0);
  const m = new RegExp("([A-Za-z_][\\w.]*)\\s*\\(");
  void m; void before;
  // position of the callee: search occurrences on this line with k ending at name
  const occs = cache.occ.get(file) ?? [];
  const nameWord = call.name.split(".").pop() ?? call.name;
  let key: string | null = null;
  // occurrence matching the callee token (Ref kind)
  const lineText = doc.text.split("\n")[line] ?? "";
  const col = lineText.lastIndexOf(call.name + "(", ch) >= 0
    ? lineText.lastIndexOf(call.name + "(", ch) : null;
  if (col !== null) {
    const occ = occs.find((o) => o.line === line && o.c0 >= (col ?? 0) && o.c0 <= (col ?? 0) + call.name.length + 1
      && (o.kind === "Ref" || o.kind === "decl"));
    if (occ) key = occ.k;
  }
  if (key === null) {
    // resolve a bare/dotted name through the file's aliases (as written)
    const parts = call.name.split(".");
    if (parts.length > 1 && meta.aliases[parts[0]] !== undefined) {
      key = meta.aliases[parts[0]] + "." + parts.slice(1).join(".");
    } else if (parts.length > 1 && !meta.ns) {
      key = call.name;
    } else {
      const cand = meta.ns ? meta.ns + "." + nameWord : nameWord;
      key = cache.book.tlds[cand] !== undefined ? cand
        : (cache.book.tlds[call.name] !== undefined ? call.name : null);
    }
  }
  if (key === null || cache.book.tlds[key] === undefined) return null;
  const tld = cache.book.tlds[key];
  if (tld.$ !== "Def" || !tld.T) return null;
  const tele = teleOf(tld.T);
  if (tele.length === 0) return null;
  const rest = safeShow(() => Bend.term_show(Bend.term_lower((function findRest(t: any): any {
    while (t && t.$ === "All") t = t.B;
    return t;
  })(tld.T)), -1, []));
  const label = key + "(" + tele.map((p) => p.name + ": " + p.type).join(", ") + ")";
  let idx = 0;
  const params = tele.map((p) => {
    const beg = label.indexOf(p.name + ": ", idx);
    const end = beg + (p.name + ": " + p.type).length;
    idx = end;
    return { label: [beg, end] };
  });
  return { signatures: [{ label, parameters: params }], activeSignature: 0,
    activeParameter: Math.min(call.argIndex, tele.length - 1) };
}

// ---- rename (top-level and local) -----------------------------------------

async function recheckRenames(text: string, dir: string): Promise<boolean> {
  // a rename is only offered if the result still parses and loads
  if (!Bend) return false;
  const tmp = path.join(dir, ".bendlsp-rename-check.bend");
  try {
    fs.writeFileSync(tmp, text, "utf8");
    const book = Bend.book_nil();
    await Bend.book_load(book, tmp, "", new Map());
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

// is this law filled by a def in any loaded file? (keys are entry-relative,
// so match by name across files whose import graph includes the law's file)
function lawProvenSomewhere(lawFile: string, lawName: string): boolean {
  const nm = lawName.split(".").pop()!;
  for (const [, c] of caches) {
    for (const [p, meta] of c.files) {
      if (p === lawFile) continue;
      const d2 = meta.decls.find((x) =>
        x.kind === "def" && x.name.split(".").pop() === nm);
      if (!d2) continue;
      const importsLaw = Object.values(meta.aliases).some((ns) =>
        [...c.files.values()].some((f) => f.ns === ns && f.path === lawFile));
      if (importsLaw) return true;
    }
  }
  return false;
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
    case "workspace/didChangeWatchedFiles":
      // an imported file changed on disk: re-check every open bend doc
      for (const uri of docs.keys()) schedule(uri, 0);
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
        signatureHelpProvider: { triggerCharacters: ["(", ","] },
        codeActionProvider: { codeActionKinds: ["refactor"] },
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
      if (at) {
        const cache = cacheOf(params.textDocument.uri)!;
        const h = hoverOf(at.key, cache.book);
        return h ? { contents: { kind: "markdown", value: h } } : null;
      }
      // a local: parameter (type from the def's tele) or let/pattern binding
      const loc = localAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!loc) return null;
      const cache = cacheOf(params.textDocument.uri)!;
      let extra = "";
      if (loc.defKey && cache.book.tlds[loc.defKey] && cache.book.tlds[loc.defKey].T) {
        const tele = teleOf(cache.book.tlds[loc.defKey].T);
        const param = tele.find((p) => p.name === loc.name);
        if (param) extra = "\n```bend\n" + loc.name + ": " + param.type + "\n```";
      }
      const value = "```bend\n" + loc.name + " — local" + (loc.defKey ? " in " + loc.defKey : "") + "\n```" + extra;
      return { contents: { kind: "markdown", value } };
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
      for (const [, cache] of caches) {
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
      const loc = at ? null : localAt(params.textDocument.uri, params.position.line, params.position.character);
      const target = at ? { range: { start: { line: at.occ.line, character: at.occ.c0 },
        end: { line: at.occ.line, character: at.occ.c1 } }, placeholder: at.key }
        : loc ? { range: { start: { line: loc.occ.line, character: loc.occ.c0 },
          end: { line: loc.occ.line, character: loc.occ.c1 } }, placeholder: loc.name } : null;
      if (!target) return null;
      if (at) {
        const cache = cacheOf(params.textDocument.uri)!;
        if (!cache.book.tlds[at.key] && !cache.book.ctrs[at.key]) return null;
      }
      return target;
    }
    case "textDocument/rename": {
      const uri = params.textDocument.uri;
      const newName: string = params.newName;
      const line = params.position.line, ch = params.position.character;
      const cache = cacheOf(uri);
      const file = uriFile(uri);
      if (!cache || !file) return null;
      const meta = cache.files.get(file);
      if (!meta) return null;
      const at = keyAt(uri, line, ch);
      const changes: Record<string, any[]> = {};
      const add = (u: string, l: number, c0: number, c1: number) => {
        (changes[u] = changes[u] ?? []).push(
          { range: { start: { line: l, character: c0 }, end: { line: l, character: c1 } }, newText: newName });
      };
      if (at) {
        // top-level rename: name-keyed occurrences across every known file
        let count = 0;
        for (const [, c] of caches) {
          for (const [p, occs] of c.occ) {
            for (const o of occs) {
              if (o.k === at.key && o.kind !== "Var" && o.kind !== "PVar" && o.kind !== "binder") {
                add(pathToFileURL(p).href, o.line, o.c0, o.c1);
                count++;
              }
            }
          }
          for (const [p, m2] of c.files) {
            for (const d of m2.decls) {
              if (d.key === at.key) { add(pathToFileURL(p).href, d.line, d.c0, d.c1); count++; }
            }
          }
        }
        return count > 0 ? { changes } : null;
      }
      // local rename: every Var/PVar/binder span of this name inside the
      // enclosing def (shadowing preserves semantics; Refs never match)
      const loc = localAt(uri, line, ch);
      if (!loc || !loc.defKey) return null;
      const decl = meta.decls.find((d) => d.key === loc.defKey)!;
      let next = meta.decls.find((d) => d.line > decl.line);
      const endLine = next ? next.line : meta.text.split("\n").length;
      const occs = cache.occ.get(file) ?? [];
      const seen = new Set<string>();
      const spans = occs.filter((o) => {
        if (!((o.kind === "Var" || o.kind === "PVar" || o.kind === "binder")
          && o.k === loc.name && o.line >= decl.line && o.line < endLine)) return false;
        const id = o.line + ":" + o.c0 + ":" + o.c1; // the same token can be binder and use
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (spans.length === 0) return null;
      // build the edited text and let the real checker confirm it still loads
      const lines = meta.text.split("\n");
      const edited = lines.map((l, i) => {
        const onLine = spans.filter((s) => s.line === i).sort((a, b) => b.c0 - a.c0);
        for (const s of onLine) {
          l = l.slice(0, s.c0) + newName + l.slice(s.c1);
        }
        return l;
      }).join("\n");
      if (!await recheckRenames(edited, path.dirname(file))) return null;
      for (const s of spans) add(uri, s.line, s.c0, s.c1);
      return { changes };
    }
    case "textDocument/documentSymbol": {
      const cache = cacheOf(params.textDocument.uri);
      const file = uriFile(params.textDocument.uri);
      if (!cache || !file) return [];
      const meta = cache.files.get(file);
      if (!meta) return [];
      return meta.decls.map((d) => ({
        name: d.name,
        kind: d.kind === "type" ? 23 : d.kind === "import" ? 2 : 12,
        location: { uri: params.textDocument.uri,
          range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } } },
      }));
    }
    case "workspace/symbol": {
      const q: string = (params.query || "").toLowerCase();
      const out: any[] = [];
      for (const [, cache] of caches) {
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
    case "textDocument/signatureHelp":
      return signatureHelpFor(params.textDocument.uri, params.position.line, params.position.character);
    case "textDocument/codeAction": {
      // "Bend: prove this law" — scaffold a def with the law's parameters
      const uri = params.textDocument.uri;
      const cache = cacheOf(uri);
      const file = uriFile(uri);
      if (!cache || !file) return [];
      const meta = cache.files.get(file);
      if (!meta) return [];
      const range = params.range;
      const out: any[] = [];
      for (const d of meta.decls) {
        if (d.kind !== "law" || d.key === undefined) continue;
        if (d.line < range.start.line || d.line > range.end.line) continue;
        const tld = cache.book.tlds[d.key];
        if (!tld || tld.$ !== "Def") continue;
        if (lawProvenSomewhere(file, d.name)) continue; // filled by a def (often PROOF.bend)
        // law parameters, straight from the user's `for x: T` lines (the
        // lowered type desugars them into Exists/Lam wrappers)
        const lines = meta.text.split("\n");
        const params: string[] = [];
        for (let i = d.line + 1; i < lines.length; i++) {
          if (/^\s*$/.test(lines[i])) continue;
          const mF = /^\s*for\s+([+-~]?)([A-Za-z_]\w*)\s*:/.exec(lines[i]);
          if (mF) { params.push(mF[2]); continue; }
          if (/^\s*exs\s/.test(lines[i])) continue; // a witness, not a parameter
          break; // the claim body starts here
        }
        const insertAt = (() => {
          const next = meta.decls.find((x) => x.line > d.line);
          let end = (next ? next.line : lines.length);
          while (end - 1 > d.line && !lines[end - 1].trim()) end--;
          return end;
        })();
        const scaffold = "def " + d.name + "(" + params.join(", ") + "):\n  ?TODO\n";
        out.push({
          title: "Bend: prove this law (scaffold def with ?TODO)",
          kind: "refactor",
          edit: { changes: { [uri]: [{ range: {
            start: { line: insertAt, character: 0 }, end: { line: insertAt, character: 0 } },
            newText: scaffold }] } },
        });
      }
      return out;
    }
    default: throw new Error("MethodNotFound: " + method);
  }
};

process.stdin.resume();
