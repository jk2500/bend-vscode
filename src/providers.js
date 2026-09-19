// providers.js - VS Code providers that forward to the Bend language server.
// Pure plumbing: every answer comes from the server, which uses the real
// Bend checker. No language knowledge lives in this file.

const vscode = require('vscode');

// kinds: LSP numeric values match vscode enum values for completion/symbol kinds
const SYMBOL_KIND = { type: vscode.SymbolKind.Struct, import: vscode.SymbolKind.Namespace,
  def: vscode.SymbolKind.Function, law: vscode.SymbolKind.Function };

function toRange(r) {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}
function toLocation(l) {
  return new vscode.Location(vscode.Uri.parse(l.uri), toRange(l.range));
}

function register(client, ctx) {
  const srv = () => client();
  const sel = { language: 'bend' };

  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(sel, {
      provideCompletionItems: async (doc, pos) => {
        const s = srv(); if (!s) return [];
        const res = await s.request('textDocument/completion', {
          textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character },
        });
        return (res || []).map(i => {
          const item = new vscode.CompletionItem(i.label, i.kind);
          if (i.detail) item.detail = i.detail;
          if (i.insert) { item.insertText = new vscode.SnippetString(i.insert); item.kind = vscode.CompletionItemKind.Snippet; }
          return item;
        });
      },
    }, '.', '{'),

    vscode.languages.registerHoverProvider(sel, {
      provideHover: async (doc, pos) => {
        const s = srv(); if (!s) return null;
        const res = await s.request('textDocument/hover', {
          textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character },
        });
        if (!res || !res.contents) return null;
        const md = new vscode.MarkdownString(res.contents.value || String(res.contents));
        return new vscode.Hover(md);
      },
    }),

    vscode.languages.registerDefinitionProvider(sel, {
      provideDefinition: async (doc, pos) => {
        const s = srv(); if (!s) return null;
        const res = await s.request('textDocument/definition', {
          textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character },
        });
        return (res || []).map(toLocation);
      },
    }),

    vscode.languages.registerReferenceProvider(sel, {
      provideReferences: async (doc, pos, ctx2) => {
        const s = srv(); if (!s) return null;
        const res = await s.request('textDocument/references', {
          textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character },
          context: { includeDeclaration: !!ctx2.includeDeclaration },
        });
        return (res || []).map(toLocation);
      },
    }),

    vscode.languages.registerDocumentSymbolProvider(sel, {
      provideDocumentSymbols: async (doc) => {
        const s = srv(); if (!s) return [];
        const res = await s.request('textDocument/documentSymbol', {
          textDocument: { uri: doc.uri.toString() } });
        return (res || []).map(si => new vscode.SymbolInformation(
          si.name, si.kind in SYMBOL_KIND ? SYMBOL_KIND[si.kind] : vscode.SymbolKind.Function,
          '', toLocation(si.location)));
      },
    }),

    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: async (query) => {
        const s = srv(); if (!s) return [];
        const res = await s.request('workspace/symbol', { query: query || '' });
        return (res || []).map(si => new vscode.SymbolInformation(
          si.name, vscode.SymbolKind.Function, '', toLocation(si.location)));
      },
    }),

    vscode.languages.registerRenameProvider(sel, {
      prepareRename: async (doc, pos) => {
        const s = srv(); if (!s) return null;
        const res = await s.request('textDocument/prepareRename', {
          textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character },
        });
        return res ? toRange(res.range) : null;
      },
      provideRenameEdits: async (doc, pos, newName) => {
        const s = srv(); if (!s) return null;
        const res = await s.request('textDocument/rename', {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character }, newName,
        });
        if (!res || !res.changes) return null;
        const edit = new vscode.WorkspaceEdit();
        for (const [uri, edits] of Object.entries(res.changes)) {
          edit.set(vscode.Uri.parse(uri), edits.map(e => new vscode.TextEdit(toRange(e.range), e.newText)));
        }
        return edit;
      },
    }),

    vscode.languages.registerFoldingRangeProvider(sel, {
      provideFoldingRanges: async (doc) => {
        const s = srv(); if (!s) return [];
        const res = await s.request('textDocument/foldingRange', {
          textDocument: { uri: doc.uri.toString() } });
        return (res || []).map(f => new vscode.FoldingRange(f.startLine, f.endLine));
      },
    }),

    vscode.languages.registerDocumentSemanticTokensProvider(sel, {
      provideDocumentSemanticTokens: async (doc) => {
        const s = srv(); if (!s) return null;
        const res = await s.request('textDocument/semanticTokens/full', {
          textDocument: { uri: doc.uri.toString() } });
        if (!res) return null;
        return new vscode.SemanticTokens(new Uint32Array(res.data));
      },
    }, new vscode.SemanticTokensLegend([
      'function', 'law', 'type', 'constructor', 'variable',
      'parameter', 'hole', 'module', 'keyword',
    ])),
  );
}

module.exports = { register };
