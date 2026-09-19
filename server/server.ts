#!/usr/bin/env bun
// server.ts - the Bend language server.
//
// Language intelligence comes from Bend itself: this process imports the
// real checker (~/.bend/current/bend2/bend.ts, the same code `bend` runs)
// and reports its structured results. Nothing about the language is
// reimplemented here; this file is only LSP protocol plumbing (zero deps).
//
// Run: bun server.ts   (speakes LSP over stdio)

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
      const vdir = path.join(app, ver);
      for (const hash of fs.readdirSync(vdir)) {
        const p = path.join(vdir, hash, "bend2", "bend.ts");
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

// a visible range for a span: widen point spans by one character on the line
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

// ---- documents -----------------------------------------------------------

type Doc = { text: string; version: number; timer: any; running: boolean;
  pending: boolean; checked: number; last: number };

const docs = new Map<string, Doc>();

function docOf(uri: string): Doc | undefined {
  return docs.get(uri);
}

function schedule(uri: string, delay: number): void {
  const doc = docOf(uri);
  if (!doc) return;
  if (doc.timer) clearTimeout(doc.timer);
  doc.timer = setTimeout(() => { doc.timer = null; void check(uri); }, delay);
}

// materialize the buffer on disk so the real checker (which reads files)
// sees exactly the editor's text; relative imports keep working because the
// shadow file sits beside the real one.
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
      Bend.book_valid(book, 0);
    } catch (e: any) {
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
        diagnostics.push({ range: rangeOf(undefined), severity: 1, source: "bend",
          message: String(e) });
      }
      report(uri, version, diagnostics, status);
      return;
    }
    // check passed: holes and unsafe terms are workflow states, not errors
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
      }, serverInfo: { name: "bend-lsp" } };
    case "shutdown": return null;
    case "bend/checkNow": schedule(params.uri, 0); return null;
    default: throw new Error("MethodNotFound: " + method);
  }
};

process.stdin.resume();
