#!/usr/bin/env bun
// server.ts - the Bend language server.
//
// Language intelligence comes from Bend itself: this process imports the
// real checker (~/.bend/current/bend2/bend.ts, the same code `bend` runs)
// and reports its structured results. Nothing about the language is
// reimplemented here; this file is only LSP protocol plumbing (zero deps).
//
// v2.3: workspace-wide index, canonical symbol ids (keys are entry-relative),
// document highlight, selection ranges, parameter-name inlay hints,
// call hierarchy, import links, safe formatter.

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

function teleOf(T: any): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  let t: any = T;
  try { t = Bend.term_lower(T); } catch { /* keep raw if it cannot lower */ }
  while (t && t.$ === "All") {
    out.push({ name: t.k, type: safeShow(() => Bend.term_show(Bend.term_lower(t.A), -1, [])) });
    t = t.B;
  }
  return out;
}

// ---- workspace model built from the checker's own Book ------------------

// occurrence: one name token in one file. cid = canonical symbol id
// (<file>#<name>); kind: Ref/Var/PVar/PCtr/Hol use, binder, decl, Ref-call
type Occ = { k: string; kind: string; line: number; c0: number; c1: number; cid: string | null; def: string | null };
type Decl = { kind: "def" | "law" | "type" | "import"; name: string; key: string | null;
  line: number; c0: number; c1: number; cid: string; target: string | null };
type FileMeta = { path: string; ns: string; aliases: Record<string, string>;
  aliasRels: Record<string, string>; text: string; stripped: string; decls: Decl[] };
type Cache = { book: any; files: Map<string, FileMeta>; occ: Map<string, Occ[]>;
  spans: Map<string, { line: number; c0: number; c1: number }[]> };

const caches = new Map<string, Cache>();       // uri -> cache (open docs)
const projectFiles = new Map<string, FileMeta>(); // every .bend under root
const projectOcc = new Map<string, Occ[]>();   // path -> occurrences (lazy)
const projectSpans = new Map<string, { line: number; c0: number; c1: number }[]>();

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

// mirror of bend.ts's namespace join: posix.join normalizes './' away
function nsJoin(ns: string, rel: string): string {
  return path.posix.join(path.posix.dirname(ns === "" ? "." : ns), rel).replace(/\.bend$/, "");
}

// canonical symbol of a decl: dotted names live in the imported file
function canonicalOf(meta: FileMeta, name: string): { file: string; name: string } {
  const parts = name.split(".");
  if (parts.length > 1 && meta.aliasRels[parts[0]] !== undefined) {
    try {
      const target = path.resolve(path.dirname(meta.path), meta.aliasRels[parts[0]]);
      if (fs.existsSync(target)) return { file: fs.realpathSync(target), name: parts.slice(1).join(".") };
    } catch { /* fall through */ }
  }
  return { file: meta.path, name };
}

const cidOf = (file: string, name: string): string => file + "#" + name;

function scanDecls(meta: FileMeta): void {
  const decls: Decl[] = [];
  const lines = meta.text.split("\n");
  const keyOf = (nm: string): string | null => {
    const parts = nm.split(".");
    if (parts.length > 1) {
      const target = meta.aliases[parts[0]];
      if (target !== undefined) return target + "." + parts.slice(1).join(".");
      return nm;
    }
    return meta.ns ? meta.ns + "." + nm : nm;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s/.test(l)) continue; // top level is column 0
    let m = /^(def|law)\s+([A-Za-z_][\w.]*)/.exec(l);
    if (m) {
      const c0 = l.indexOf(m[2]);
      const c = canonicalOf(meta, m[2]);
      decls.push({ kind: m[1] as "def" | "law", name: m[2], key: keyOf(m[2]), line: i, c0,
        c1: c0 + m[2].length, cid: cidOf(c.file, c.name), target: c.file });
      continue;
    }
    m = /^type\s+([A-Za-z_]\w*)/.exec(l);
    if (m) {
      const c0 = l.indexOf(m[1]);
      const c = canonicalOf(meta, m[1]);
      decls.push({ kind: "type", name: m[1], key: keyOf(m[1]), line: i, c0, c1: c0 + m[1].length,
        cid: cidOf(c.file, c.name), target: c.file });
      continue;
    }
    m = /^import\s+(\S+)(?:\s+as\s+(\w+))?/.exec(l);
    if (m) {
      const shown = m[2] || m[1];
      const c0 = l.indexOf(shown, 6);
      let target: string | null = null;
      if (m[2]) {
        try {
          const t = path.resolve(path.dirname(meta.path), m[1]);
          if (fs.existsSync(t)) target = fs.realpathSync(t);
        } catch { /* external */ }
      }
      decls.push({ kind: "import", name: shown, key: null, line: i, c0, c1: c0 + shown.length,
        cid: cidOf(meta.path, shown), target });
    }
  }
  meta.decls = decls;
}

function metaOf(path: string, ns: string, text: string): FileMeta {
  const aliases: Record<string, string> = {};
  const aliasRels: Record<string, string> = {};
  for (const im of readImports(text)) {
    if (im.alias) { aliases[im.alias] = nsJoin(ns, im.rel); aliasRels[im.alias] = im.rel; }
  }
  const meta: FileMeta = { path, ns, aliases, aliasRels, text, stripped: stripImports(text), decls: [] };
  scanDecls(meta);
  return meta;
}

function importGraph(entryPath: string, entryText: string | null): Map<string, FileMeta> {
  const files = new Map<string, FileMeta>();
  const visit = (p: string, ns: string): void => {
    const real = fs.realpathSync(p);
    if (files.has(real)) return;
    const isEntry = real === fs.realpathSync(entryPath);
    const text = isEntry && entryText !== null ? entryText : fs.readFileSync(real, "utf8");
    files.set(real, metaOf(real, ns, text));
    for (const im of readImports(text)) {
      if (im.rel === "Base" || im.rel.startsWith("0x") || !im.alias) continue;
      visit(path.resolve(path.dirname(p), im.rel), nsJoin(ns, im.rel));
    }
  };
  try { visit(entryPath, ""); } catch { /* partial graph is fine */ }
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
    if (idx < 0) return [];
    out.push({ name: nm, beg: s.beg + idx, end: s.beg + idx + nm.length });
    at = idx + nm.length;
  }
  return out;
}

// occurrences + all term spans for a loaded book. Walks LOWERED terms: the
// parsed tree keeps bodies behind closures until term_lower applies them.
function analyze(book: any, files: Map<string, FileMeta>):
  { occ: Map<string, Occ[]>; spans: Map<string, { line: number; c0: number; c1: number }[]> } {
  const srcToFile = new Map<string, string>();
  for (const [p, meta] of files) srcToFile.set(meta.stripped, p);
  const occ = new Map<string, Occ[]>();
  const spans = new Map<string, { line: number; c0: number; c1: number }[]>();
  const pathBySrc = (src: string): string | null => srcToFile.get(src) ?? null;
  let curDef: string | null = null; // cid of the def being walked
  const defOf = (p: string): string | null => {
    const meta = files.get(p);
    if (!meta) return null;
    return curDef;
  };
  const emitOcc = (k: string, kind: string, src: string, beg: number, end: number, cid: string | null): void => {
    const p = pathBySrc(src);
    if (p === null) return;
    const a = posOf(src, beg), b = posOf(src, end);
    const arr = occ.get(p) ?? [];
    arr.push({ k, kind, line: a.line, c0: a.character, c1: b.character, cid, def: defOf(p) });
    occ.set(p, arr);
  };
  const emitSpan = (src: string, beg: number, end: number): void => {
    const p = pathBySrc(src);
    if (p === null) return;
    const a = posOf(src, beg), b = posOf(src, end);
    if (b.line < a.line || (b.line === a.line && b.character <= a.character)) return;
    const arr = spans.get(p) ?? [];
    arr.push({ line: a.line, c0: a.character, c1: b.character });
    spans.set(p, arr);
  };
  // canonicalize an occurrence name through the file's aliases; Base names
  // (b === true) canonically live in base.bend
  const cidFor = (p: string, k: string): string | null => {
    const meta = files.get(p);
    if (!meta) return null;
    const tld = book.tlds[k];
    if (tld && tld.b === true) return "Base#" + k;
    const parts = k.split(".");
    if (parts.length > 1 && meta.aliasRels[parts[0]] !== undefined) {
      const c = canonicalOf(meta, k);
      return cidOf(c.file, c.name);
    }
    if (meta.ns && k.startsWith(meta.ns + ".")) return cidOf(meta.path, k.slice(meta.ns.length + 1));
    return cidOf(meta.path, k);
  };
  const walk = (t: any, depth = 0): void => {
    if (!t || typeof t !== "object" || depth > 90) return;
    if (Array.isArray(t)) { for (const x of t) walk(x, depth + 1); return; }
    if (typeof t === "function") return;
    if (t.s && t.s.end > t.s.beg) emitSpan(t.s.src, t.s.beg, t.s.end);
    if (t.s && t.s.end > t.s.beg) {
      const p = pathBySrc(t.s.src);
      if (t.$ === "Ref" || t.$ === "PCtr") {
        emitOcc(t.k, t.$, t.s.src, t.s.beg, t.s.end, p ? cidFor(p, t.k) : null);
      } else if (t.$ === "Var" || t.$ === "PVar" || t.$ === "Hol") {
        const txt = t.s.src.slice(t.s.beg, t.s.end);
        const idx = txt.lastIndexOf(t.k);
        const [b0, b1] = idx >= 0 && t.k.length > 0
          ? [t.s.beg + idx, t.s.beg + idx + t.k.length] : [t.s.beg, t.s.end];
        emitOcc(t.k, t.$, t.s.src, b0, b1, null); // locals: cid per (file, def, name)
      } else if (t.$ === "Lam" || t.$ === "All" || t.$ === "Let") {
        for (const b of binderNameSpans(t.k, t.s)) emitOcc(b.name, "binder", t.s.src, b.beg, b.end, null);
      }
    }
    if (t.$ === "App" && t.f && t.f.$ === "App") {
      // peel the call chain later via Ref-call marking below
    }
    for (const v of Object.values(t)) if (typeof v === "object") walk(v, depth + 1);
  };
  // mark callee refs: App(App(f,a),b) — innermost f is the callee
  const markCallees = (t: any, depth = 0): void => {
    if (!t || typeof t !== "object" || depth > 90) return;
    if (Array.isArray(t)) { for (const x of t) markCallees(x, depth + 1); return; }
    if (typeof t === "function") return;
    if (t.$ === "App") {
      let head: any = t;
      while (head.$ === "App") head = head.f;
      if (head.$ === "Ref" && head.s && head.s.end > head.s.beg) {
        const p = pathBySrc(head.s.src);
        if (p) {
          const a = posOf(head.s.src, head.s.beg), b = posOf(head.s.src, head.s.end);
          const arr = occ.get(p) ?? [];
          const dup = arr.some((x) => x.kind === "Ref-call" && x.line === a.line
            && x.c0 === a.character && x.k === head.k);
          if (!dup) {
            arr.push({ k: head.k, kind: "Ref-call", line: a.line, c0: a.character, c1: b.character,
              cid: cidFor(p, head.k), def: defOf(p) });
            occ.set(p, arr);
          }
        }
      }
    }
    for (const v of Object.values(t)) if (typeof v === "object") markCallees(v, depth + 1);
  };
  for (const [key, tld] of Object.entries<any>(book.tlds)) {
    if (tld.b === true) continue; // Base: not part of this workspace
    void key;
    const declFile = (() => {
      // which file declares this tld? match by def order against file decls
      for (const [p, meta] of files) {
        if (meta.decls.some((d) => d.key === key || d.name === key.split(".").pop())) return p;
      }
      return null;
    })();
    const saveDef = curDef;
    if (declFile) {
      const meta = files.get(declFile)!;
      const d = meta.decls.find((x) => x.key === key || x.name === key.split(".").pop());
      if (d) curDef = d.cid;
    }
    try {
      if (tld.$ === "Def") {
        if (tld.T) { walk(Bend.term_lower(tld.T)); markCallees(Bend.term_lower(tld.T)); }
        if (tld.v) { walk(Bend.term_lower(tld.v)); markCallees(Bend.term_lower(tld.v)); }
        if (tld.e) { walk(Bend.term_lower(tld.e)); markCallees(Bend.term_lower(tld.e)); }
      } else if (tld.$ === "ADT") {
        walk(Bend.term_lower(tld.T));
        for (const c of tld.c) walk(Bend.term_lower(c.T));
      }
    } catch { /* a def that cannot lower still contributes the others */ }
    curDef = saveDef;
  }
  return { occ, spans };
}

// ---- workspace-wide project index (files never opened) -------------------

function buildProjectIndex(root: string): void {
  const skip = new Set([".git", "node_modules", "target", "dist", ".venv"]);
  const walk = (dir: string, depth: number): void => {
    if (depth > 10) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p, depth + 1); }
      else if (e.name.endsWith(".bend") && !e.name.startsWith(".")) {
        try { projectFiles.set(fs.realpathSync(p), metaOf(fs.realpathSync(p), "", fs.readFileSync(p, "utf8"))); }
        catch { /* unreadable: skip */ }
      }
    }
  };
  walk(root, 0);
}

// occurrences for a project file, loaded through the real checker once
function ensureProjectOcc(p: string): Occ[] {
  const hit = projectOcc.get(p);
  if (hit) return hit;
  const occ = analyzeBookFor(p);
  projectOcc.set(p, occ.occ);
  projectSpans.set(p, occ.spans);
  return occ.occ;
}

function analyzeBookFor(entryPath: string): { occ: Occ[]; spans: any[] } {
  if (!Bend) return { occ: [], spans: [] };
  try {
    const book = Bend.book_nil();
    Bend.book_load(book, entryPath, "", new Map());
    const files = importGraph(entryPath, null);
    const { occ, spans } = analyze(book, files);
    // keep only the entry's own occurrences (imports have their own entries)
    return { occ: occ.get(fs.realpathSync(entryPath)) ?? [], spans: spans.get(fs.realpathSync(entryPath)) ?? [] };
  } catch {
    return { occ: [], spans: [] };
  }
}

// every file -> occurrences, for project-wide queries
function allOccs(): Map<string, Occ[]> {
  const out = new Map<string, Occ[]>();
  for (const [uri, cache] of caches) {
    for (const [p, occs] of cache.occ) out.set(p, occs);
  }
  for (const p of projectFiles.keys()) {
    if (!out.has(p)) out.set(p, ensureProjectOcc(p));
  }
  return out;
}

function allFiles(): Map<string, FileMeta> {
  const out = new Map<string, FileMeta>();
  for (const [, cache] of caches) for (const [p, meta] of cache.files) out.set(p, meta);
  for (const [p, meta] of projectFiles) if (!out.has(p)) out.set(p, meta);
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
    try {
      await Bend.book_load(book, file, "", new Map());
      const entryText = shadow ? text : null;
      const files = importGraph(file, entryText);
      const a = analyze(book, files);
      caches.set(uri, { book, files, occ: a.occ, spans: a.spans });
      const realFile = fs.realpathSync(file);
      if (projectFiles.has(realFile)) {
        projectFiles.set(realFile, files.get(realFile)!); // fresh in-memory meta
        projectOcc.delete(realFile); projectSpans.delete(realFile);
      }
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
            for (const [i, ann] of anns.slice(0, CTX_LINES_MAX)) {
              parts.push("  " + ann.k + ": "
                + safeShow(() => Bend.term_show(Bend.term_lower(Bend.term_snf(err.bok, ann.T), i), -1, bnd.slice(0, i))));
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

// ---- features ------------------------------------------------------------

function cacheOf(uri: string): Cache | undefined {
  return caches.get(uri);
}

function uriFile(uri: string): string | null {
  try { return uri.startsWith("file:") ? fs.realpathSync(fileURLToPath(uri)) : null; }
  catch { return null; }
}

// the top-level symbol at a position
function keyAt(uri: string, line: number, ch: number):
  { cid: string; occ: Occ; meta: FileMeta } | null {
  const file = uriFile(uri);
  if (!file) return null;
  const cache = cacheOf(uri);
  const occs = (cache && cache.occ.get(file)) ?? projectOcc.get(file) ?? [];
  const meta = (cache && cache.files.get(file)) ?? projectFiles.get(file);
  const occ = occs.find((o) => o.line === line && ch >= o.c0 && ch <= o.c1
    && o.kind !== "Var" && o.kind !== "PVar" && o.kind !== "binder" && o.cid);
  if (occ && meta) return { cid: occ.cid!, occ, meta };
  if (meta) {
    for (const d of meta.decls) {
      if (d.kind !== "import" && d.line === line && ch >= d.c0 && ch <= d.c1) {
        return { cid: d.cid, occ: { k: d.name, kind: "decl", line, c0: d.c0, c1: d.c1, cid: d.cid, def: null }, meta };
      }
    }
  }
  return null;
}

// the local at a position, and its enclosing def
function localAt(uri: string, line: number, ch: number):
  { name: string; defCid: string | null; defKey: string | null; occ: Occ } | null {
  const file = uriFile(uri);
  if (!file) return null;
  const cache = cacheOf(uri);
  const meta = (cache && cache.files.get(file)) ?? projectFiles.get(file);
  if (!meta) return null;
  const occs = (cache && cache.occ.get(file)) ?? projectOcc.get(file) ?? [];
  const occ = occs.find((o) => (o.kind === "Var" || o.kind === "PVar" || o.kind === "binder")
    && o.line === line && ch >= o.c0 && ch <= o.c1);
  if (!occ) return null;
  let defCid: string | null = occ.def;
  let best = -1;
  let defKey: string | null = null;
  for (const d of meta.decls) {
    if (d.kind !== "import" && d.line <= line && d.line > best) { best = d.line; defCid = d.cid; defKey = d.key; }
  }
  return { name: occ.k, defCid, defKey, occ };
}

// all decl sites with this canonical id, across every known file
function declSitesOfCid(cid: string): { uri: string; range: any; kind: string }[] {
  const out: { uri: string; range: any; kind: string }[] = [];
  if (cid.startsWith("Base#")) {
    const site = baseDeclSite(cid.slice(5));
    if (site) out.push(site);
    return out;
  }
  for (const [p, meta] of allFiles()) {
    for (const d of meta.decls) {
      if (d.kind !== "import" && d.cid === cid) {
        out.push({ uri: pathToFileURL(p).href, kind: d.kind,
          range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } } });
      }
    }
  }
  return out;
}

function declSiteOfCid(cid: string): { uri: string; range: any } | null {
  const sites = declSitesOfCid(cid);
  return sites.find((s) => s.kind === "law") ?? sites[0] ?? null;
}

// decl sites of Base names, read from base.bend itself
let baseDecls: Map<string, { line: number; c0: number; c1: number; kind: string }> | null = null;
function baseDeclSite(name: string): { uri: string; range: any; kind: string } | null {
  if (!baseDecls) {
    baseDecls = new Map();
    try {
      const bp = path.join(path.dirname(BEND_TS!), "base.bend");
      const lines = fs.readFileSync(bp, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = /^(?:def|law|type)\s+([A-Za-z_][\w.]*)/.exec(lines[i]);
        if (m) {
          const c0 = lines[i].indexOf(m[1]);
          baseDecls.set(m[1], { line: i, c0, c1: c0 + m[1].length, kind: m[0].split(" ")[0] });
        }
      }
      (baseDecls as any).uri = pathToFileURL(path.join(path.dirname(BEND_TS!), "base.bend")).href;
    } catch { /* base index is best-effort */ }
  }
  const d = baseDecls.get(name);
  if (!d) return null;
  return { uri: (baseDecls as any).uri,
    range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } }, kind: d.kind };
}

async function hoverOf(cid: string, cache: Cache | undefined): Promise<string | null> {
  if (cid.startsWith("Base#")) {
    const name = cid.slice(5);
    const tld = cache && cache.book.tlds ? cache.book.tlds[name] : null;
    if (tld) {
      const t = safeShow(() => Bend.term_show(Bend.term_lower(tld.T), -1, []));
      const tele = tld.$ === "Def" && tld.T ? teleOf(tld.T).map((p) => p.name + ": " + p.type).join(", ") : null;
      const law = tld.$ === "Def" && tld.v === null ? " (open law)" : "";
      return "```bend\ndef " + name + " — Base" + law + "\n  :: " + t + "\n```"
        + (tele ? "\n```bend\n(" + tele + ")\n```" : "");
    }
    const ctr = cache && cache.book.ctrs ? cache.book.ctrs[name] : null;
    if (ctr) {
      const t = safeShow(() => Bend.term_show(Bend.term_lower(ctr.T), -1, []));
      return "```bend\nconstructor " + name + " (arity " + ctr.n + ") — Base\n  :: " + t + "\n```";
    }
    return null;
  }
  const file = cid.slice(0, cid.lastIndexOf("#"));
  const name = cid.slice(cid.lastIndexOf("#") + 1);
  // prefer the open document's own book: exact key, then ns-qualified match
  if (cache && cache.book.tlds) {
    const keys = Object.keys(cache.book.tlds);
    const hit = keys.find((k) => k === name)
      ?? keys.find((k) => k.endsWith("." + name) && !cache.book.tlds[k].b)
      ?? keys.find((k) => k.endsWith("." + name));
    const tld = hit ? cache.book.tlds[hit] : null;
    if (tld) {
      const kind = tld.$ === "ADT" ? "type" : "def";
      const t = safeShow(() => Bend.term_show(Bend.term_lower(tld.T), -1, []));
      const base = tld.b === true ? " — Base" : "";
      const law = tld.$ === "Def" && tld.v === null ? " (open law)" : "";
      const tele = tld.$ === "Def" && tld.v !== null && tld.T
        ? teleOf(tld.T).map((p) => p.name + ": " + p.type).join(", ") : null;
      return "```bend\n" + kind + " " + name + base + law + "\n  :: " + t + "\n```"
        + (tele ? "\n```bend\n(" + tele + ")\n```" : "");
    }
    const ctr = cache.book.ctrs ? cache.book.ctrs[name] : null;
    if (ctr) {
      const t = safeShow(() => Bend.term_show(Bend.term_lower(ctr.T), -1, []));
      return "```bend\nconstructor " + name + " (arity " + ctr.n + ")\n  :: " + t + "\n```";
    }
  }
  // a file that was never opened: load its book through the real checker
  if (Bend && fs.existsSync(file)) {
    try {
      const b = Bend.book_nil();
      await Bend.book_load(b, file, "", new Map());
      const hitK = Object.keys(b.tlds).find((k) => k === name || k.endsWith("." + name));
      const tld = hitK ? b.tlds[hitK] : null;
      if (tld) {
        const kind = tld.$ === "ADT" ? "type" : "def";
        const t = safeShow(() => Bend.term_show(Bend.term_lower(tld.T), -1, []));
        const law = tld.$ === "Def" && tld.v === null ? " (open law)" : "";
        return "```bend\n" + kind + " " + name + law + "\n  :: " + t + "\n```";
      }
      const ctr = b.ctrs ? b.ctrs[name] : null;
      if (ctr) {
        const t = safeShow(() => Bend.term_show(Bend.term_lower(ctr.T), -1, []));
        return "```bend\nconstructor " + name + " (arity " + ctr.n + ")\n  :: " + t + "\n```";
      }
    } catch { /* unreadable */ }
  }
  return null;
}

function completionsIn(meta: FileMeta, book: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(book.tlds)) {
    let shown: string | null = null;
    if (meta.ns !== "" && key.startsWith(meta.ns + ".")) {
      shown = key.slice(meta.ns.length + 1);
    } else {
      for (const [alias, target] of Object.entries(meta.aliases)) {
        if (key.startsWith(target + ".")) { shown = alias + key.slice(target.length); break; }
      }
    }
    if (shown === null && !key.includes("/")) shown = key;
    if (!shown || seen.has(shown)) continue;
    seen.add(shown);
    const tld = book.tlds[key];
    const isLaw = tld.$ === "Def" && tld.v === null;
    out.push({ label: shown,
      kind: tld.$ === "ADT" ? 23 : 3,
      detail: (tld.b === true ? "Base · " : "") + (isLaw ? "law" : "def") + " :: "
        + safeShow(() => Bend.term_show(Bend.term_lower(tld.T), -1, []).slice(0, 160)) });
  }
  for (const key of Object.keys(book.ctrs)) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ label: key, kind: 20, detail: "constructor, arity " + book.ctrs[key].n });
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

const TOKEN_TYPES = ["function", "law", "type", "constructor", "variable",
  "parameter", "hole", "module", "keyword"];

function semanticTokensOf(uri: string): { data: number[] } | null {
  const file = uriFile(uri);
  if (!file) return null;
  const cache = cacheOf(uri);
  const meta = (cache && cache.files.get(file)) ?? projectFiles.get(file);
  const occs = (cache && cache.occ.get(file)) ?? projectOcc.get(file) ?? [];
  if (!meta) return null;
  const book = cache ? cache.book : null;
  const toks: { line: number; c0: number; len: number; t: number }[] = [];
  const push = (line: number, c0: number, len: number, t: number) => {
    if (len > 0) toks.push({ line, c0, len, t });
  };
  for (const d of meta.decls) {
    if (d.kind === "import") push(d.line, d.c0, d.c1 - d.c0, 7);
    else if (d.kind === "type") push(d.line, d.c0, d.c1 - d.c0, 2);
    else push(d.line, d.c0, d.c1 - d.c0, d.kind === "law" ? 1 : 0);
  }
  for (const o of occs) {
    const isCtor = o.kind === "PCtr" || (o.kind.startsWith("Ref") && book && book.ctrs[o.k] !== undefined);
    const t = isCtor ? 3 : o.kind === "Var" ? 4 : (o.kind === "PVar" || o.kind === "binder") ? 5
      : o.kind === "Hol" ? 6 : o.kind.startsWith("Ref") ? 0 : 4;
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

function foldingOf(uri: string): any[] | null {
  const doc = docOf(uri);
  const file = uriFile(uri);
  const meta = file ? ((cacheOf(uri)?.files.get(file)) ?? projectFiles.get(file)) : undefined;
  if (!doc && !meta) return null;
  const text = meta ? meta.text : doc!.text;
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

// signature help ------------------------------------------------------------

function callAt(text: string, line: number, ch: number): { name: string; argIndex: number } | null {
  const lines = text.split("\n");
  const upto = lines.slice(0, line).join("\n").length + (line ? 1 : 0) + ch;
  const all = text.slice(0, upto);
  let depth = 0;
  let argIdx = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const c = all[i];
    if (c === ")" || c === "}" || c === "]") depth++;
    else if (c === "(" || c === "{" || c === "[") {
      if (depth === 0 && c === "(") {
        const m = /([A-Za-z_][\w.]*)\s*$/.exec(all.slice(0, i));
        return m ? { name: m[1], argIndex: argIdx } : null;
      }
      depth--;
    } else if (depth === 0 && c === ",") argIdx++;
  }
  return null;
}

function signatureHelpFor(uri: string, line: number, ch: number): any | null {
  const doc = docOf(uri);
  const file = uriFile(uri);
  const cache = cacheOf(uri);
  if (!doc || !cache || !file) return null;
  const call = callAt(doc.text, line, ch);
  if (!call) return null;
  const meta = cache.files.get(file);
  if (!meta) return null;
  const occs = cache.occ.get(file) ?? [];
  const nameWord = call.name.split(".").pop() ?? call.name;
  let key: string | null = null;
  const lineText = doc.text.split("\n")[line] ?? "";
  const openCol = lineText.lastIndexOf(call.name + "(");
  if (openCol >= 0) {
    const occ = occs.find((o) => o.line === line && o.c0 >= openCol && o.c0 <= openCol + call.name.length
      && (o.kind.startsWith("Ref") || o.kind === "decl"));
    if (occ) key = occ.k;
  }
  if (key === null) {
    const parts = call.name.split(".");
    if (parts.length > 1 && meta.aliases[parts[0]] !== undefined) {
      key = meta.aliases[parts[0]] + "." + parts.slice(1).join(".");
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
  let t: any = tld.T;
  try { t = Bend.term_lower(tld.T); } catch { /* raw */ }
  while (t && t.$ === "All") t = t.B;
  const ret = safeShow(() => Bend.term_show(Bend.term_lower(t), -1, []));
  const label = key + "(" + tele.map((p) => p.name + ": " + p.type).join(", ") + ") -> " + ret;
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

// inlay hints: parameter names at call sites ---------------------------------

function inlayHintsOf(uri: string, rng: any): any[] | null {
  const file = uriFile(uri);
  if (!file) return null;
  const cache = cacheOf(uri);
  const meta = (cache && cache.files.get(file)) ?? projectFiles.get(file);
  if (!meta || !cache) return null; // need the book for teles
  const occs = cache.occ.get(file) ?? [];
  const text = meta.text;
  const out: any[] = [];
  const lines = text.split("\n");
  // for each call occurrence, hint the first argument's parameter name
  for (const o of occs) {
    if (o.kind !== "Ref-call" || !o.cid) continue;
    if (rng && (o.line < rng.start.line || o.line > rng.end.line)) continue;
    const name = o.k.split(".").pop()!;
    const tld = cache.book.tlds[o.k] ?? cache.book.tlds[meta.ns ? meta.ns + "." + name : name];
    if (!tld || tld.$ !== "Def" || !tld.T) continue;
    const tele = teleOf(tld.T);
    if (tele.length === 0) continue;
    const l = lines[o.line] ?? "";
    const callStr = name + "(";
    let at = l.indexOf(callStr, Math.max(0, o.c0 - 2));
    if (at < 0) at = o.c0;
    const openParen = l.indexOf("(", at);
    if (openParen < 0) continue;
    // first argument hint: text between '(' and the first top-level ',' / ')'
    let depth = 0, argEnd = -1;
    for (let i = openParen + 1; i < l.length; i++) {
      if (l[i] === "(" || l[i] === "{") depth++;
      else if (l[i] === ")" || l[i] === "}") { if (depth === 0) { argEnd = i; break; } depth--; }
      else if (l[i] === "," && depth === 0) { argEnd = i; break; }
    }
    if (argEnd < 0) continue;
    const first = l.slice(openParen + 1, argEnd).trim();
    if (!first || first.startsWith('"')) continue;
    const p0 = tele[0];
    if (p0.name === "_" || p0.name === first) continue;
    if (!out.some((h) => h.position.line === o.line && h.position.character === openParen + 1)) {
      out.push({ position: { line: o.line, character: openParen + 1 },
        label: p0.name + ": ", kind: 2 /* Parameter */ });
    }
  }
  return out;
}

// selection ranges: nest every term span in this file ------------------------

function selectionRangesOf(uri: string, positions: any[]): any[] | null {
  const file = uriFile(uri);
  if (!file) return null;
  const cache = cacheOf(uri);
  const spans = (cache && cache.spans.get(file)) ?? projectSpans.get(file) ?? [];
  const meta = (cache && cache.files.get(file)) ?? projectFiles.get(file);
  if (!meta) return null;
  const lines = meta.text.split("\n");
  return positions.map((pos) => {
    const chain: any[] = [];
    let cur: any = { start: { line: pos.line, character: pos.character }, end: { line: pos.line, character: pos.character } };
    const containing = spans
      .filter((s) => (s.line < pos.line || (s.line === pos.line && s.c0 <= pos.character))
        && (s.line > pos.line || (s.line === pos.line && s.c1 >= pos.character))
        && !(s.line === pos.line && s.c0 === pos.character && s.c1 === pos.character))
      .sort((a, b) => ((b.c1 - b.c0) - (a.c1 - a.c0)) || (b.line - a.line));
    for (const s of containing) {
      const r = { start: { line: s.line, character: s.c0 }, end: { line: s.line, character: s.c1 } };
      if (r.start.line === r.end.line) {
        chain.push({ range: r });
        cur = r;
      } else {
        chain.push({ range: r });
        cur = r;
      }
    }
    const lineR = { start: { line: pos.line, character: 0 },
      end: { line: pos.line, character: (lines[pos.line] ?? "").length } };
    chain.push({ range: lineR });
    chain.push({ range: { start: { line: 0, character: 0 },
      end: { line: lines.length - 1, character: (lines[lines.length - 1] ?? "").length } } });
    // link the chain
    for (let i = chain.length - 2; i >= 0; i--) chain[i].parent = chain[i + 1];
    return chain[0];
  });
}

// call hierarchy ---------------------------------------------------------------

function callItemOf(uri: string, line: number, ch: number): any | null {
  const at = keyAt(uri, line, ch);
  if (!at) return null;
  const site = declSiteOfCid(at.cid);
  if (!site) return null;
  return { name: at.occ.k.split(".").pop(), kind: 12, uri: site.uri, range: site.range,
    selectionRange: site.range };
}

function incomingCalls(cid: string): any[] {
  const out = new Map<string, any>();
  for (const [p, occs] of allOccs()) {
    for (const o of occs) {
      if (o.kind !== "Ref-call" || o.cid !== cid || !o.def) continue;
      const from = declSitesOfCid(o.def)[0];
      if (!from) continue;
      const id = from.uri;
      if (!out.has(id)) {
        out.set(id, { name: o.def.split("#").pop(), kind: 12, uri: from.uri,
          range: from.range, selectionRange: from.range,
          fromRanges: [{ start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } }] });
      } else {
        out.get(id).fromRanges.push({ start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } });
      }
    }
  }
  return [...out.values()];
}

function outgoingCalls(defCid: string): any[] {
  const [file] = [defCid.slice(0, defCid.lastIndexOf("#"))];
  const out = new Map<string, any>();
  for (const [p, occs] of allOccs()) {
    if (p !== file) continue;
    for (const o of occs) {
      if (o.kind !== "Ref-call" || o.def !== defCid || !o.cid) continue;
      const to = declSitesOfCid(o.cid)[0];
      if (!to) continue;
      if (!out.has(o.cid)) {
        out.set(o.cid, { name: o.cid.split("#").pop(), kind: 12, uri: to.uri,
          range: to.range, selectionRange: to.range,
          fromRanges: [{ start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } }] });
      } else {
        out.get(o.cid).fromRanges.push({ start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } });
      }
    }
  }
  return [...out.values()];
}

// formatter: whitespace-only, layout is semantic in Bend ----------------------

function formatTextOf(text: string): { newText: string; changes: number } {
  const lines = text.replace(/\t/g, "  ").split("\n").map((l) => {
    const trimmed = l.replace(/[ \t]+$/, "");
    return trimmed;
  });
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const newText = lines.join("\n") + "\n";
  const changes = newText === text ? 0 : 1;
  return { newText, changes };
}

// law proven somewhere (canonical ids make this a cid lookup) -----------------

function lawProvenSomewhere(cid: string): boolean {
  for (const [p, meta] of allFiles()) {
    for (const d of meta.decls) {
      if (d.kind === "def" && d.cid === cid) return true; // a def with the same canonical id fills it
    }
  }
  return false;
}

// whole-project diagnostics (startup + watched-file changes): like a C++/
// Python extension, files show in Problems without being opened
let projectCheckTimer: any = null;
async function checkProject(): Promise<void> {
  if (!Bend) return;
  for (const p of projectFiles.keys()) {
    // an open doc owns its own diagnostics
    if ([...caches.keys()].some((u) => uriFile(u) === p)) continue;
    let diagnostics: any[] = [];
    let status = { errors: 0, todos: 0, unsafe: 0, ok: true };
    const book = Bend.book_nil();
    try {
      await Bend.book_load(book, p, "", new Map());
      Bend.book_valid(book, 0);
      const todos = (book.hols ?? 0) + (book.open ?? 0);
      if (todos > 0) {
        status = { errors: 0, todos, unsafe: 0, ok: true };
        diagnostics = [{ range: rangeOf(undefined), severity: 3, source: "bend",
          message: todos + " open claim" + (todos === 1 ? "" : "s") + " (holes) — not yet a valid proof." }];
      } else {
        const unsafe = Object.values(book.tlds).filter((t: any) => t && t.$ === "Def" && t.u === true).length;
        if (unsafe > 0) {
          status = { errors: 0, todos: 0, unsafe, ok: true };
          diagnostics = [{ range: rangeOf(undefined), severity: 2, source: "bend",
            message: unsafe + " term" + (unsafe === 1 ? "" : "s") + " annotated as unsafe — well-typed, but may contain logical paradoxes." }];
        }
      }
    } catch (e: any) {
      const err = e;
      status = { errors: 1, todos: 0, unsafe: 0, ok: false };
      if (err && err.$ === "Err") {
        const bnd = Bend.ctx_scope(err.ctx);
        const msg = err.obs !== undefined
          ? "expected: " + safeShow(() => Bend.expr_show(err.bok, err.exp, bnd))
            + "\nobserved: " + safeShow(() => Bend.expr_show(err.bok, err.obs, bnd))
          : safeShow(() => Bend.expr_show(err.bok, err.exp, bnd));
        diagnostics = [{ range: rangeOf(err.spn), severity: 1, source: "bend",
          message: msg + (err.def !== undefined ? "\nin def: " + err.def : "") }];
      } else {
        diagnostics = [{ range: rangeOf(undefined), severity: 1, source: "bend", message: String(e) }];
      }
    }
    peer.notify("textDocument/publishDiagnostics", { uri: pathToFileURL(p).href, diagnostics });
  }
}

function scheduleProjectCheck(delay: number): void {
  if (projectCheckTimer) clearTimeout(projectCheckTimer);
  projectCheckTimer = setTimeout(() => { projectCheckTimer = null; void checkProject(); }, delay);
}

async function recheckRenames(text: string, dir: string): Promise<boolean> {
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
      // refresh the project index for changed files, then re-check open docs
      for (const ch of params.changes ?? []) {
        try {
          const p = uriFile(ch.uri);
          if (p && p.endsWith(".bend")) {
            if (fs.existsSync(p)) {
              projectFiles.set(p, metaOf(p, "", fs.readFileSync(p, "utf8")));
            } else {
              projectFiles.delete(p);
            }
            projectOcc.delete(p); projectSpans.delete(p);
          }
        } catch { /* ignore */ }
      }
      for (const uri of docs.keys()) schedule(uri, 0);
      scheduleProjectCheck(2000); // imports may have changed project-wide
      return;
    case "exit": process.exit(0); return;
    default: return;
  }
};

peer.requestHandler = async (method: string, params: any) => {
  switch (method) {
    case "initialize": {
      const rootUri = params.rootUri;
      if (rootUri && rootUri.startsWith("file:")) {
        try { buildProjectIndex(fileURLToPath(rootUri)); } catch { /* index is best-effort */ }
        peer.notify("window/logMessage", { type: 3, message:
          "bend-lsp: indexed " + projectFiles.size + " workspace .bend files; checker "
          + (BEND_TS ? BEND_TS : "NOT FOUND") });
        scheduleProjectCheck(300); // whole-project diagnostics at startup
      }
      return { capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: true },
        completionProvider: { triggerCharacters: ["."], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        foldingRangeProvider: true,
        selectionRangeProvider: true,
        documentLinkProvider: {},
        documentFormattingProvider: true,
        signatureHelpProvider: { triggerCharacters: ["(", ","] },
        codeActionProvider: { codeActionKinds: ["refactor"] },
        callHierarchyProvider: true,
        inlayHintProvider: { resolveProvider: false },
        semanticTokensProvider: {
          legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] },
          full: true,
        },
      }, serverInfo: { name: "bend-lsp" } };
    }
    case "shutdown": return null;
    case "bend/checkNow": schedule(params.uri, 0); return null;
    case "textDocument/completion": {
      const uri = params.textDocument.uri;
      const file = uriFile(uri);
      const cache = cacheOf(uri);
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
        const h = await hoverOf(at.cid, cacheOf(params.textDocument.uri));
        return h ? { contents: { kind: "markdown", value: h } } : null;
      }
      const loc = localAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!loc) return null;
      const cache = cacheOf(params.textDocument.uri);
      let extra = "";
      if (loc.defKey && cache && cache.book.tlds[loc.defKey] && cache.book.tlds[loc.defKey].T) {
        const tele = teleOf(cache.book.tlds[loc.defKey].T);
        const param = tele.find((p) => p.name === loc.name);
        if (param) extra = "\n```bend\n" + loc.name + ": " + param.type + "\n```";
      }
      const value = "```bend\n" + loc.name + " — local" + (loc.defKey ? " in " + loc.defKey.split(".").pop() : "") + "\n```" + extra;
      return { contents: { kind: "markdown", value } };
    }
    case "textDocument/definition": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      const site = declSiteOfCid(at.cid);
      return site ? [site] : null;
    }
    case "textDocument/references": {
      const at = keyAt(params.textDocument.uri, params.position.line, params.position.character);
      if (!at) return null;
      const out: any[] = [];
      for (const [p, occs] of allOccs()) {
        for (const o of occs) {
          if (o.cid === at.cid) out.push({ uri: pathToFileURL(p).href,
            range: { start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } } });
        }
      }
      if (params.context && params.context.includeDeclaration) {
        for (const s of declSitesOfCid(at.cid)) out.push(s);
      }
      return out;
    }
    case "textDocument/documentHighlight": {
      const uri = params.textDocument.uri;
      const at = keyAt(uri, params.position.line, params.position.character);
      const file = uriFile(uri);
      if (!file) return null;
      if (at) {
        return ((cacheOf(uri)?.occ.get(file)) ?? projectOcc.get(file) ?? [])
          .filter((o) => o.cid === at.cid)
          .map((o) => ({ range: { start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } }, kind: 1 }));
      }
      // a local: highlight same-name locals within the enclosing def
      const loc = localAt(uri, params.position.line, params.position.character);
      if (!loc) return null;
      const meta = (cacheOf(uri)?.files.get(file)) ?? projectFiles.get(file);
      const occs = (cacheOf(uri)?.occ.get(file)) ?? projectOcc.get(file) ?? [];
      if (!meta) return null;
      const decl = meta.decls.find((d) => d.cid === loc.defCid);
      if (!decl) return null;
      const next = meta.decls.find((d) => d.line > decl.line);
      const endLine = next ? next.line : meta.text.split("\n").length;
      return occs.filter((o) => (o.kind === "Var" || o.kind === "PVar" || o.kind === "binder")
        && o.k === loc.name && o.line >= decl.line && o.line < endLine)
        .map((o) => ({ range: { start: { line: o.line, character: o.c0 }, end: { line: o.line, character: o.c1 } }, kind: 1 }));
    }
    case "textDocument/prepareRename": {
      const uri = params.textDocument.uri;
      const at = keyAt(uri, params.position.line, params.position.character);
      const loc = at ? null : localAt(uri, params.position.line, params.position.character);
      if (at) {
        if (declSitesOfCid(at.cid).length === 0) return null;
        return { range: { start: { line: at.occ.line, character: at.occ.c0 },
          end: { line: at.occ.line, character: at.occ.c1 } }, placeholder: at.occ.k.split(".").pop() };
      }
      if (loc) {
        return { range: { start: { line: loc.occ.line, character: loc.occ.c0 },
          end: { line: loc.occ.line, character: loc.occ.c1 } }, placeholder: loc.name };
      }
      return null;
    }
    case "textDocument/rename": {
      const uri = params.textDocument.uri;
      const newName: string = params.newName;
      const line = params.position.line, ch = params.position.character;
      const file = uriFile(uri);
      if (!file) return null;
      const cache = cacheOf(uri);
      const meta = (cache && cache.files.get(file)) ?? projectFiles.get(file);
      if (!meta) return null;
      const changes: Record<string, any[]> = {};
      const add = (u: string, l: number, c0: number, c1: number) => {
        (changes[u] = changes[u] ?? []).push(
          { range: { start: { line: l, character: c0 }, end: { line: l, character: c1 } }, newText: newName });
      };
      const at = keyAt(uri, line, ch);
      if (at) {
        // top-level: canonical-id occurrences in every file of the workspace
        for (const [p, occs] of allOccs()) {
          for (const o of occs) {
            if (o.cid === at.cid && o.kind !== "Var" && o.kind !== "PVar" && o.kind !== "binder") {
              add(pathToFileURL(p).href, o.line, o.c0, o.c1);
            }
          }
        }
        for (const [p, m2] of allFiles()) {
          for (const d of m2.decls) {
            if (d.cid === at.cid) add(pathToFileURL(p).href, d.line, d.c0, d.c1);
          }
        }
        return Object.keys(changes).length > 0 ? { changes } : null;
      }
      // local rename: every Var/PVar/binder span of this name inside the
      // enclosing def (shadowing preserves semantics; Refs never match)
      const loc = localAt(uri, line, ch);
      if (!loc || !loc.defCid) return null;
      const decl = meta.decls.find((d) => d.cid === loc.defCid);
      if (!decl) return null;
      const next = meta.decls.find((d) => d.line > decl.line);
      const endLine = next ? next.line : meta.text.split("\n").length;
      const occs = (cache && cache.occ.get(file)) ?? projectOcc.get(file) ?? [];
      const seen = new Set<string>();
      const spans = occs.filter((o) => {
        if (!((o.kind === "Var" || o.kind === "PVar" || o.kind === "binder")
          && o.k === loc.name && o.line >= decl.line && o.line < endLine)) return false;
        const id = o.line + ":" + o.c0 + ":" + o.c1;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (spans.length === 0) return null;
      const lines = meta.text.split("\n");
      const edited = lines.map((l, i) => {
        const onLine = spans.filter((s) => s.line === i).sort((a, b) => b.c0 - a.c0);
        for (const s of onLine) l = l.slice(0, s.c0) + newName + l.slice(s.c1);
        return l;
      }).join("\n");
      if (!await recheckRenames(edited, path.dirname(file))) return null;
      for (const s of spans) add(uri, s.line, s.c0, s.c1);
      return { changes };
    }
    case "textDocument/documentSymbol": {
      const file = uriFile(params.textDocument.uri);
      const meta = file ? ((cacheOf(params.textDocument.uri)?.files.get(file)) ?? projectFiles.get(file)) : null;
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
      for (const [p, meta] of allFiles()) {
        for (const d of meta.decls) {
          if (d.kind === "import") continue;
          if (q && !d.name.toLowerCase().includes(q)) continue;
          out.push({ name: d.name, kind: d.kind === "type" ? 23 : 12,
            location: { uri: pathToFileURL(p).href,
              range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } } } });
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
    case "textDocument/inlayHint":
      return inlayHintsOf(params.textDocument.uri, params.range);
    case "textDocument/selectionRange":
      return selectionRangesOf(params.textDocument.uri, params.positions);
    case "textDocument/documentLink": {
      const file = uriFile(params.textDocument.uri);
      const meta = file ? ((cacheOf(params.textDocument.uri)?.files.get(file)) ?? projectFiles.get(file)) : null;
      if (!meta) return [];
      return meta.decls.filter((d) => d.kind === "import" && d.target)
        .map((d) => ({ range: { start: { line: d.line, character: d.c0 }, end: { line: d.line, character: d.c1 } },
          target: pathToFileURL(d.target!).href }));
    }
    case "textDocument/formatting": {
      const doc = docOf(params.textDocument.uri);
      if (!doc) return null;
      const { newText, changes } = formatTextOf(doc.text);
      if (changes === 0) return [];
      return [{ range: { start: { line: 0, character: 0 }, end: { line: doc.text.split("\n").length, character: 0 } }, newText }];
    }
    case "callHierarchy/prepare": {
      const item = callItemOf(params.textDocument.uri, params.position.line, params.position.character);
      return item ? [item] : null;
    }
    case "callHierarchy/incomingCalls": {
      const item = params.item;
      const cid = uriFile(item.uri) ? cidOf(uriFile(item.uri)!, item.name) : null;
      return cid ? incomingCalls(cid) : [];
    }
    case "callHierarchy/outgoingCalls": {
      const item = params.item;
      const cid = uriFile(item.uri) ? cidOf(uriFile(item.uri)!, item.name) : null;
      return cid ? outgoingCalls(cid) : [];
    }
    case "textDocument/codeAction": {
      const uri = params.textDocument.uri;
      const file = uriFile(uri);
      const cache = cacheOf(uri);
      if (!cache || !file) return [];
      const meta = cache.files.get(file);
      if (!meta) return [];
      const range = params.range;
      const out: any[] = [];
      for (const d of meta.decls) {
        if (d.kind !== "law") continue;
        if (d.line < range.start.line || d.line > range.end.line) continue;
        if (lawProvenSomewhere(d.cid)) continue; // filled by a def (often PROOF.bend)
        const lines = meta.text.split("\n");
        const params2: string[] = [];
        for (let i = d.line + 1; i < lines.length; i++) {
          if (/^\s*$/.test(lines[i])) continue;
          const mF = /^\s*for\s+([+-~]?)([A-Za-z_]\w*)\s*:/.exec(lines[i]);
          if (mF) { params2.push(mF[2]); continue; }
          if (/^\s*exs\s/.test(lines[i])) continue; // a witness, not a parameter
          break;
        }
        const insertAt = (() => {
          const next = meta.decls.find((x) => x.line > d.line);
          let end = (next ? next.line : lines.length);
          while (end - 1 > d.line && !lines[end - 1].trim()) end--;
          return end;
        })();
        const scaffold = "def " + d.name + "(" + params2.join(", ") + "):\n  ?TODO\n";
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
