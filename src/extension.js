// bend-vscode: the Bend language server client.
//
// Language intelligence runs in server/server.ts (bun), which imports the
// real Bend checker from the installed toolchain. This file only spawns it,
// relays LSP, and maps diagnostics to squiggles. If bun or the toolchain is
// missing it falls back to the old CLI-text mode.

const vscode = require('vscode');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { RpcPeer } = require('./rpc');
const { parseBendOutput } = require('./bendParser');
const providers = require('./providers');

const BEND = path.join(os.homedir(), '.bend', 'bin', 'bend');
const TIMEOUT_MS = 15000;

// ---- state ------------------------------------------------------------

let server = null;        // { child, peer, ready }
let serverGone = false;   // after a crash: stop retrying, use CLI mode
const statuses = new Map(); // uri -> {errors,todos,unsafe,ok}

// ---- CLI fallback (the v1.1 path, kept for machines without bun) ------

function checkDocumentCLI(doc, diag, status) {
  if (!doc || doc.languageId !== 'bend' || doc.isUntitled) return;
  const cwd = path.dirname(doc.fileName);
  const outC = path.join(os.tmpdir(), 'bend-vscode-check-' + process.pid + '.c');
  const child = spawn(BEND, [path.basename(doc.fileName), '-o', outC], {
    cwd, env: { ...process.env, PATH: path.dirname(BEND) + ':' + process.env.PATH, BEND_NO_TELEMETRY: '1' }, timeout: TIMEOUT_MS
  });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  child.on('error', () => { status.text = 'Bend: bend not found (~/.bend/bin)'; status.tooltip = 'Install: curl -fsSL https://bend-lang.com/install.sh | sh'; });
  child.on('close', (code) => {
    if (out.includes('installer')) out = out.split('installer')[0];
    const { errors, todos, ok } = parseBendOutput(out);
    const diags = [];
    for (const e of errors) {
      diags.push(new vscode.Diagnostic(doc.lineAt(Math.min(e.line - 1, doc.lineCount - 1)).range,
        e.message, vscode.DiagnosticSeverity.Error));
    }
    if (todos > 0) {
      diags.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0),
        todos + ' open claim' + (todos > 1 ? 's' : '') + ' (TODO) - laws stated, not yet proven',
        vscode.DiagnosticSeverity.Information));
    }
    diag.set(doc.uri, diags);
    if (errors.length) status.text = '$(error) Bend: ' + errors.length + ' error' + (errors.length > 1 ? 's' : '');
    else if (todos > 0) status.text = '$(circle-outline) Bend: ' + todos + ' open claim' + (todos > 1 ? 's' : '');
    else if (ok) status.text = '$(check) Bend: All terms check';
    else status.text = 'Bend: checked';
  });
}

// ---- language server mode ---------------------------------------------

function findBun() {
  const cands = [process.env.BEND_LSP_BUN, 'bun', path.join(os.homedir(), '.bun', 'bin', 'bun')].filter(Boolean);
  for (const c of cands) {
    if (path.isAbsolute(c) ? fs.existsSync(c) : true) return c; // 'bun' resolved by PATH at spawn
  }
  return null;
}

function startServer(ctx, diag, status) {
  if (!vscode.workspace.getConfiguration('bend2.server').get('enabled', true)) {
    status.text = 'Bend: LSP off (setting) - CLI mode';
    return false;
  }
  const bun = findBun();
  const serverTs = path.join(ctx.extensionPath, 'server', 'server.ts');
  if (!bun || !fs.existsSync(serverTs)) {
    status.text = 'Bend: LSP off (bun not found) - CLI mode';
    return false;
  }
  const child = spawn(bun, [serverTs], { stdio: ['pipe', 'pipe', 'pipe'] });
  const peer = new RpcPeer(child.stdout, child.stdin);
  server = { child, peer, ready: false };
  child.stderr.on('data', d => console.error('[bend-lsp]', String(d).trim()));
  child.on('exit', () => {
    server = null;
    if (!serverGone) {
      serverGone = true;
      status.text = 'Bend: language server exited - CLI mode';
      vscode.window.showWarningMessage('Bend language server exited; falling back to CLI checking.');
    }
  });
  peer.notificationHandler = (method, params) => {
    if (method === 'textDocument/publishDiagnostics') {
      const uri = vscode.Uri.parse(params.uri);
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === params.uri);
      if (open && params.version !== undefined && params.version < open.version) return; // stale
      const diags = (params.diagnostics || []).map(d => new vscode.Diagnostic(
        new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character),
        d.message,
        d.severity === 1 ? vscode.DiagnosticSeverity.Error
          : d.severity === 2 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information));
      diag.set(uri, diags);
    } else if (method === 'bend/status') {
      statuses.set(params.uri, params);
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === params.uri) {
        showStatus(status, params);
      }
    }
  };
  peer.requestHandler = async () => null;
  peer.request('initialize', {
    processId: process.pid,
    rootUri: vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
      ? vscode.Uri.parse(vscode.workspace.workspaceFolders[0].uri.toString()).toString() : null,
    capabilities: {},
  }).then(() => {
    server.ready = true;
    peer.notify('initialized', {});
    for (const d of vscode.workspace.textDocuments) {
      if (d.languageId === 'bend') openDoc(d);
    }
  }).catch(() => { /* exit handler picks this up */ });
  return true;
}

function openDoc(doc) {
  if (!server || !server.ready) return;
  server.peer.notify('textDocument/didOpen', {
    textDocument: { uri: doc.uri.toString(), languageId: doc.languageId, version: doc.version, text: doc.getText() },
  });
}

function showStatus(status, s) {
  if (s.errors) status.text = '$(error) Bend: ' + s.errors + ' error' + (s.errors > 1 ? 's' : '');
  else if (s.todos) status.text = '$(circle-outline) Bend: ' + s.todos + ' open claim' + (s.todos > 1 ? 's' : '');
  else if (s.unsafe) status.text = '$(warning) Bend: all terms check (' + s.unsafe + ' unsafe)';
  else if (s.ok) status.text = '$(check) Bend: All terms check';
}

// ---- activation ---------------------------------------------------------

function activate(ctx) {
  const diag = vscode.languages.createDiagnosticCollection('bend');
  providers.register(() => server, ctx);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'bend2.check';
  ctx.subscriptions.push(diag, status,
    vscode.workspace.onDidOpenTextDocument(d => {
      if (d.languageId !== 'bend') return;
      if (server) openDoc(d); else checkDocumentCLI(d, diag, status);
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!server || !server.ready || e.document.languageId !== 'bend') return;
      server.peer.notify('textDocument/didChange', {
        textDocument: { uri: e.document.uri.toString(), version: e.document.version },
        contentChanges: [{ text: e.document.getText() }], // full sync
      });
    }),
    vscode.workspace.onDidSaveTextDocument(d => {
      if (!server || d.languageId !== 'bend') return;
      server.peer.notify('textDocument/didSave', { textDocument: { uri: d.uri.toString() } });
    }),
    vscode.workspace.onDidCloseTextDocument(d => {
      if (!server || d.languageId !== 'bend') return;
      statuses.delete(d.uri.toString());
      server.peer.notify('textDocument/didClose', { textDocument: { uri: d.uri.toString() } });
    }),
    vscode.window.onDidChangeActiveTextEditor(ed => {
      const s = ed && statuses.get(ed.document.uri.toString());
      if (s) showStatus(status, s); else if (ed && ed.document.languageId === 'bend') status.text = 'Bend: checking…';
    }),
    vscode.commands.registerCommand('bend2.check', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'bend') return;
      if (server && server.ready) server.peer.request('bend/checkNow', { uri: ed.document.uri.toString() }).catch(() => {});
      else checkDocumentCLI(ed.document, diag, status);
    }),
    vscode.commands.registerCommand('bend2.restartServer', async () => {
      if (server) { try { server.child.kill(); } catch {} }
      serverGone = false;
      startServer(ctx, diag, status);
    })
  );
  const started = startServer(ctx, diag, status);
  if (!started) {
    for (const d of vscode.workspace.textDocuments) if (d.languageId === 'bend') checkDocumentCLI(d, diag, status);
  }
  status.show();
}
module.exports = { activate, deactivate() { if (server) { try { server.child.kill(); } catch {} } } };
