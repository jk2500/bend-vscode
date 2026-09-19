// bendIndex.js - top-level Bend parser + workspace index. No dependencies.
const fs = require('fs');
const path = require('path');

// Parse top-level declarations of a .bend source.
// Returns { decls: [{kind,name,params,ret,line,doc}], imports: [{rel,alias,line}] }
function parseTopLevel(text) {
  const decls = [];
  const imports = [];
  const lines = text.split('\n');
  let doc = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    if (t.startsWith('#')) { doc.push(t.replace(/^#\s?/, '')); continue; }
    let m;
    if ((m = t.match(/^import\s+(\S+)(?:\s+as\s+(\w+))?/))) {
      imports.push({ rel: m[1], alias: m[2] || null, line: i });
      doc = []; continue;
    }
    if ((m = t.match(/^def\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:\s*$/)) ||
        (m = t.match(/^def\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*\{/))) {
      decls.push({ kind: 'def', name: m[1], params: m[2].trim(), ret: (m[3] || '').trim(), line: i, doc: doc.join('\n') });
      doc = []; continue;
    }
    if ((m = t.match(/^law\s+([A-Za-z_][\w.]*)\s*:\s*$/))) {
      decls.push({ kind: 'law', name: m[1], params: '', ret: '', line: i, doc: doc.join('\n') });
      doc = []; continue;
    }
    if ((m = t.match(/^type\s+([A-Za-z_][\w.]*)\s+is\s+(\w+)/))) {
      decls.push({ kind: 'type', name: m[1], params: '', ret: m[2], line: i, doc: doc.join('\n') });
      doc = []; continue;
    }
    if (t.length) doc = [];
  }
  return { decls, imports };
}

function findBasePath() {
  const appDir = path.join(process.env.HOME || '', '.bend', 'app');
  if (!fs.existsSync(appDir)) return null;
  const vers = fs.readdirSync(appDir).filter(d => /^\d/.test(d)).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    return (pa[0]-pb[0]) || (pa[1]-pb[1]) || (pa[2]-pb[2]);
  });
  for (let i = vers.length - 1; i >= 0; i--) {
    const p = path.join(appDir, vers[i], 'bend2', 'base.bend');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function walkBendFiles(dir, out = [], depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'bin') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkBendFiles(p, out, depth + 1);
    else if (e.name.endsWith('.bend')) out.push(p);
  }
  return out;
}

class Index {
  constructor() { this.files = new Map(); this.base = null; }
  loadFile(absPath, text) { this.files.set(absPath, { ...parseTopLevel(text), text }); }
  addWorkspace(rootDir) { for (const p of walkBendFiles(rootDir)) { try { this.loadFile(p, fs.readFileSync(p, 'utf8')); } catch {} } }
  loadBase() { const bp = findBasePath(); if (!bp) return null; this.base = { path: bp, ...parseTopLevel(fs.readFileSync(bp, 'utf8')) }; return this.base; }
  // resolve a (possibly dotted) name in the context of a file
  lookup(name, fromPath) {
    const parts = name.split('.');
    const file = this.files.get(fromPath);
    if (parts.length > 1 && file) {
      const alias = parts[0];
      const imp = file.imports.find(im => im.alias === alias || (!im.alias && im.rel === alias));
      if (imp) {
        const target = path.resolve(path.dirname(fromPath), imp.rel);
        const rest = parts.slice(1).join('.');
        if (this.files.has(target)) {
          const d = this.files.get(target).decls.find(d => d.name === rest || d.name.endsWith('.' + rest));
          if (d) return { decl: d, file: target };
        }
      }
    }
    if (file) {
      const d = file.decls.find(d => d.name === name);
      if (d) return { decl: d, file: fromPath };
    }
    for (const [p, f] of this.files) {
      const d = f.decls.find(d => d.name === name || d.name.endsWith('.' + name));
      if (d) return { decl: d, file: p };
    }
    if (this.base) {
      const d = this.base.decls.find(d => d.name === name);
      if (d) return { decl: d, file: this.base.path };
    }
    return null;
  }
  allNames() {
    const out = [];
    for (const [p, f] of this.files) for (const d of f.decls) out.push({ ...d, file: p, from: 'workspace' });
    if (this.base) for (const d of this.base.decls) out.push({ ...d, file: this.base.path, from: 'base' });
    return out;
  }
}
module.exports = { parseTopLevel, Index, findBasePath };
