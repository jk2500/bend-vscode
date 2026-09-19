// bend-vscode: live checking for Bend 2.0 (runs the real checker, bend CLI)
const vscode = require('vscode');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { parseBendOutput } = require('./bendParser');

const BEND = path.join(os.homedir(), '.bend', 'bin', 'bend');
const TIMEOUT_MS = 15000;

function checkDocument(doc, diag, status) {
  if (!doc || doc.languageId !== 'bend' || doc.isUntitled) return;
  const cwd = path.dirname(doc.fileName);
  const outC = path.join(os.tmpdir(), 'bend-vscode-check.c');
  const child = spawn(BEND, [path.basename(doc.fileName), '-o', outC], {
    cwd, env: { ...process.env, PATH: path.dirname(BEND) + ':' + process.env.PATH, BEND_NO_TELEMETRY: '1' }, timeout: TIMEOUT_MS
  });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  child.on('error', () => { status.text = 'Bend: bend not found (~/.bend/bin)'; status.tooltip = 'Install: curl -fsSL https://bend-lang.com/install.sh | sh'; });
  child.on('close', (code) => {
    if (out.includes('installer')) out = out.split('installer')[0]; // drop updater noise
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
    const clean = code === 0 && errors.length === 0 && todos === 0 && !out.trim();
    if (errors.length) status.text = '$(error) Bend: ' + errors.length + ' error' + (errors.length > 1 ? 's' : '');
    else if (todos > 0) status.text = '$(circle-outline) Bend: ' + todos + ' open claim' + (todos > 1 ? 's' : '');
    else if (ok || clean) status.text = '$(check) Bend: All terms check';
    else status.text = 'Bend: checked';
  });
}

function activate(ctx) {
  const diag = vscode.languages.createDiagnosticCollection('bend');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'bend2.check';
  ctx.subscriptions.push(diag, status,
    vscode.workspace.onDidOpenTextDocument(d => checkDocument(d, diag, status)),
    vscode.workspace.onDidSaveTextDocument(d => checkDocument(d, diag, status)),
    vscode.workspace.onDidCloseTextDocument(d => diag.delete(d.uri)),
    vscode.commands.registerCommand('bend2.check', () => {
      const ed = vscode.window.activeTextEditor;
      if (ed) checkDocument(ed.document, diag, status);
    })
  );
  for (const d of vscode.workspace.textDocuments) checkDocument(d, diag, status);
  status.show();
}
module.exports = { activate, deactivate() {} };
