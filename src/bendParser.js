// bendParser.js - parse bend checker output into diagnostics data. No vscode dependency.
function parseBendOutput(text) {
  const errors = [];
  let todos = 0;
  let ok = false;
  const blocks = text.split(/^Error:\s*$/m);
  for (const block of blocks) {
    const todoM = block.match(/(\d+) TODOs? found/);
    if (todoM) { todos = parseInt(todoM[1], 10); continue; }
    if (/All terms check/.test(block)) { ok = true; continue; }
    if (!/expected|observed|message/.test(block)) continue;
    const parts = {};
    for (const m of block.matchAll(/^- ([a-z ]+) ?: ?(.*)$/gm)) parts[m[1].trim()] = m[2].trim();
    const locName = (block.match(/^Location: ?(\S*)/m) || [])[1] || '';
    let line = 1;
    const lm = block.match(/^(\d+)>\|/m);
    if (lm) line = parseInt(lm[1], 10);
    const bits = [];
    if (parts['expected']) bits.push('expected: ' + parts['expected']);
    if (parts['observed']) bits.push('observed: ' + parts['observed']);
    if (parts['message']) bits.push(parts['message']);
    const message = (locName ? '[' + locName + '] ' : '') + (bits.join(' \u00b7 ') || 'syntax error');
    errors.push({ line: Math.max(1, line), message });
  }
  return { errors, todos, ok };
}
module.exports = { parseBendOutput };
