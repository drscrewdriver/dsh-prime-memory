import fs from 'node:fs';

const f = 'src/tools/index.ts';
let s = fs.readFileSync(f, 'utf8');

const open = 'ctx.tools.register(';
const start = s.indexOf('ctx.tools.register(');

function matchParen(text, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const spans = [];
let searchFrom = start;
for (;;) {
  const idx = s.indexOf(open, searchFrom);
  if (idx === -1) break;
  const parenIdx = idx + open.length - 1;
  const end = matchParen(s, parenIdx);
  if (end === -1) { searchFrom = idx + open.length; continue; }
  const chunk = s.slice(idx, end + 1);
  const m = chunk.match(/name: '([a-z_]+)'/);
  spans.push({ start: idx, end: end + 1, name: m ? m[1] : '(unknown)' });
  searchFrom = end + 1;
}

const GROUPS = {
  memory_room_admin: 'room', memory_room_review: 'room',
  memory_search_graph: 'graph', memory_expand_graph_node: 'graph',
  memory_ruminate: 'ruminate', memory_ruminate_cancel: 'ruminate', memory_ruminate_status: 'ruminate',
  memory_add: 'mutate', memory_import: 'mutate', memory_delete: 'mutate',
  memory_conflicts: 'conflict', memory_conflicts_rejected: 'conflict', memory_resolve_conflict: 'conflict',
};
console.log('found:', spans.map((x) => x.name).join(', '));
const ungrouped = spans.filter((x) => !GROUPS[x.name]).map((x) => x.name);
console.log('core(不封印):', ungrouped.join(', '));

let out = s;
for (let k = spans.length - 1; k >= 0; k--) {
  const sp = spans[k];
  const group = GROUPS[sp.name];
  if (!group) continue;
  const inner = s.slice(sp.start, sp.end);
  out = out.slice(0, sp.start) + `reg('${group}', () => ${inner})` + out.slice(sp.end);
}
fs.writeFileSync(f, out);
console.log('rewritten:', spans.filter((x) => GROUPS[x.name]).length, 'registrations wrapped');
