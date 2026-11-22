// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls, finds
// the lines each edit names at the first of three matching tiers, and writes every change
// or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3), also how JSON `insert` splits `new_str`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileData {
  br: string;
  lines: string[];
  finalBr: boolean;
}
function parseFile(text: string): FileData {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBr = false;
  if (text.endsWith(br)) {
    finalBr = true;
    parts.pop();
  }
  return { br, lines: parts, finalBr };
}
function serializeFile(d: FileData): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBr ? d.br : '');
}

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where `pat` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(pat[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `pat` occurs. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, pat, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * One line of the replacement text: `ctx` is the index into the old lines of the
 * context line it is, or -1 for a line the patch adds. A context line is written
 * as the file's own matched line, never the patch's (SPEC.md section 5).
 */
interface NLine {
  text: string;
  ctx: number;
}

/** Replace `lines[pos .. pos + oLen)` by the replacement lines, applying section 5. */
function applyReplace(lines: string[], pos: number, oLen: number, oldLines: string[], repl: NLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const f = tier === 2 && oldLines.length > 0 ? lead(lines[pos]!) : '';
  const p = tier === 2 && oldLines.length > 0 ? lead(oldLines[0]!) : '';
  for (const n of repl) {
    if (n.ctx >= 0) {
      out.push(lines[pos + n.ctx]!);
    } else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) {
      out.push(f + n.text.slice(p.length));
    } else {
      out.push(n.text);
    }
  }
  for (let i = pos + oLen; i < lines.length; i++) out.push(lines[i]!);
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  private readonly origin = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Set a path's content in place (a create, a change, or an edit after a move). */
  put(p: string, v: string | null): void {
    this.now.set(p, v);
  }
  /** Delete a path; a later fresh create at it is not the moved file. */
  remove(p: string): void {
    this.origin.delete(p);
    this.now.set(p, null);
  }
  /** Move a file, remembering where its content came from for the `R` output line. */
  move(oldP: string, newP: string, v: string): void {
    const o = this.origin.get(oldP) ?? oldP;
    this.origin.delete(oldP);
    this.origin.set(newP, o);
    this.now.set(newP, v);
    this.now.set(oldP, null);
  }
  origins(): Map<string, string> {
    return this.origin;
  }
}

type Edit = (tree: Tree) => void;

/** The output rows for a finished run, byte-ordered by path (`R` rows by the new path). */
function outputRows(tree: Tree): string[] {
  const changed = new Set<string>();
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.add(p);
  }
  const rows: { key: string; line: string }[] = [];
  for (const [np, op] of tree.origins()) {
    if (op === np) continue;
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      changed.delete(op);
      changed.delete(np);
    }
  }
  for (const p of changed) {
    const was = tree.original(p);
    const nw = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : nw === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.line);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.put(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.put(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fd = parseFile(before);
      if (line < 0 || line > fd.lines.length) throw new Fail('no-match', p);
      fd.lines.splice(line, 0, ...add);
      tree.put(p, serializeFile(fd));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'slash';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
/** Whether a `\` line follows this hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i]!.kind === 'ctx' || h.body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && h.body[last + 1] !== undefined && h.body[last + 1]!.kind === 'slash';
}
/** Old lines and replacement lines of a hunk, in body order. */
function hunkOldNew(h: Hunk): { oldLines: string[]; repl: NLine[] } {
  const oldLines: string[] = [];
  const repl: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      repl.push({ text: b.text, ctx: oldLines.length });
      oldLines.push(b.text);
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      repl.push({ text: b.text, ctx: -1 });
    }
  }
  return { oldLines, repl };
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inBody = false;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const startSection = (sec: UniSection): void => {
    if (cur !== null) sections.push(cur);
    cur = sec;
    inBody = false;
  };
  const isBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ oldPath: stripAB(m[1]!), newPath: stripAB(m[2]!), hasPair: false, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        // The pair is part of this section's header, and names its paths.
        cur.oldPath = stripAB(headerPath(line));
        cur.newPath = stripAB(headerPath(lines[i + 1]!));
        cur.hasPair = true;
      } else {
        startSection({ oldPath: stripAB(headerPath(line)), newPath: stripAB(headerPath(lines[i + 1]!)), hasPair: true, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inBody = true;
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b === 'diff --git' || b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(b)) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) hunk.body.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) hunk.body.push({ kind: 'new', text: b.slice(1) });
        else hunk.body.push({ kind: 'slash', text: b.slice(1) });
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === 'ctx' && hunk.body[hunk.body.length - 1]!.text === '') {
        hunk.body.pop();
      }
      inBody = false;
      continue;
    }
    if (cur !== null && !inBody && cur.hunks.length === 0) {
      // Inside a section's header: a `--- ` line needs its `+++ ` line.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and every other header line are ignored.
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameFrom;
    const newP = sec.newPath ?? sec.renameTo;
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    const isCreate = oldP === '/dev/null' || sec.isCreate;
    const isDelete = newP === '/dev/null' || sec.isDelete;
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let finalBr = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.body.some((b) => b.kind === 'new')) {
          finalBr = !hunkNoEol(h);
          break;
        }
      }
      tree.put(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.remove(oldP);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let fd = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const { oldLines, repl } = hunkOldNew(h);
      if (oldLines.length === 0) {
        const insPos = Math.min(h.a + d, fd.lines.length);
        const added = repl.map((n) => n.text);
        const nl = [...fd.lines.slice(0, insPos), ...added, ...fd.lines.slice(insPos)];
        let finalBr = fd.finalBr;
        if (insPos === fd.lines.length) finalBr = !hunkNoEol(h);
        fd = { br: fd.br, lines: nl, finalBr };
      } else {
        const found = findTier(fd.lines, oldLines, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const nl = applyReplace(fd.lines, best, oldLines.length, oldLines, repl, found.tier);
        let finalBr = fd.finalBr;
        if (best + oldLines.length === fd.lines.length) finalBr = !hunkNoEol(h);
        fd = { br: fd.br, lines: nl, finalBr };
      }
      d += repl.length - oldLines.length;
    }
    const out = serializeFile(fd);
    if (oldP !== newP) tree.move(oldP, newP, out);
    else tree.put(oldP, out);
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const blockPath = path;
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.put(blockPath, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(blockPath);
      if (cur === null) throw new Fail('missing', blockPath);
      const fd = parseFile(cur);
      const found = findTier(fd.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.pos.length !== 1) throw new Fail('ambiguous', blockPath);
      const repl: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
      const nl = applyReplace(fd.lines, found.pos[0]!, oldLines.length, oldLines, repl, found.tier);
      tree.put(blockPath, serializeFile({ br: fd.br, lines: nl, finalBr: fd.finalBr }));
    });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  lineNo: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLineNo = i + 1;
    i += 1;
    const rawStart = i;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      i += 1;
    }
    let raw = lines.slice(rawStart, i);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], lineNo: secLineNo };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else if (l === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
    } else {
      let k = 0;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        sec.moveTo = raw[k]!.slice('*** Move to: '.length).trim();
        k += 1;
      }
      let firstChunk = true;
      while (k < raw.length) {
        const chunk: V4aChunk = { anchor: null, eof: false, body: [] };
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          chunk.anchor = l.slice(2).trim();
          k += 1;
        } else if (firstChunk && (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+'))) {
          // The first chunk starts at a body line.
        } else if (l.trim() === '*** End of File') {
          throw new Exit2(`error: parse ${rawStart + k + 1}`);
        } else {
          throw new Exit2(`error: parse ${rawStart + k + 1}`);
        }
        while (k < raw.length) {
          const b = raw[k]!;
          if (b === '') chunk.body.push({ kind: 'ctx', text: '' });
          else if (b.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) chunk.body.push({ kind: 'old', text: b.slice(1) });
          else if (b.startsWith('+')) chunk.body.push({ kind: 'new', text: b.slice(1) });
          else break;
          k += 1;
        }
        if (k < raw.length && raw[k]!.trim() === '*** End of File') {
          chunk.eof = true;
          k += 1;
        }
        sec.chunks.push(chunk);
        firstChunk = false;
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secLineNo}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => v4aSectionEdit(sec, strict));
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.put(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.remove(sec.path);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let fd = parseFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundIdx = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let j = cursor; j < fd.lines.length; j++) {
            if (lineEq(ch.anchor, fd.lines[j]!, t)) {
              foundIdx = j;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', sec.path);
        cursor = foundIdx + 1;
      }
      const { oldLines, repl } = hunkOldNew({ a: 0, body: ch.body });
      if (oldLines.length === 0) {
        const insPos = ch.eof ? fd.lines.length : cursor;
        const added = repl.map((n) => n.text);
        const nl = [...fd.lines.slice(0, insPos), ...added, ...fd.lines.slice(insPos)];
        fd = { br: fd.br, lines: nl, finalBr: fd.finalBr };
        cursor = insPos + added.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrences(fd.lines, oldLines, t, cursor).filter((p) => !ch.eof || p + oldLines.length === fd.lines.length);
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', sec.path);
        const nl = applyReplace(fd.lines, found.pos, oldLines.length, oldLines, repl, found.tier);
        fd = { br: fd.br, lines: nl, finalBr: fd.finalBr };
        cursor = found.pos + repl.length;
      }
    }
    const out = serializeFile(fd);
    if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, out);
    else tree.put(sec.path, out);
  };
}

/* ---- Command line, output and exit codes (SPEC.md sections 1 and 2) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeOrigins = new Map(tree.origins());
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.origins().clear();
      for (const [k, v] of beforeOrigins) tree.origins().set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = outputRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
