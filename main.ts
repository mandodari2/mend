// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
}

type Edit = (tree: Tree) => void;

/** Shared context for the parsers: --strict, and the moves performed (for `R` output rows). */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

// ---------- section 5: file lines and matching ----------

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(fileLines: string[], o: string[], i: number, tier: number): boolean {
  for (let j = 0; j < o.length; j++) {
    if (normLine(fileLines[i + j]!, tier) !== normLine(o[j]!, tier)) return false;
  }
  return true;
}

/** All positions where O occurs at this tier (occurrences may overlap). */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const first = normLine(o[0]!, tier);
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i++) {
    if (normLine(fileLines[i]!, tier) !== first) continue;
    if (matchesAt(fileLines, o, i, tier)) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at or after `from`, and its positions there; null when none. */
function findTierFrom(fileLines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(fileLines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One item of a hunk/chunk body: context, old, new, or backslash. */
interface BodyItem {
  k: ' ' | '-' | '+' | '\\';
  text: string;
}

interface NItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Split a body into O (context + old) and N (context + new, with the O index of each context line). */
function splitBody(body: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const item of body) {
    if (item.k === ' ') {
      const oIdx = o.length;
      o.push(item.text);
      n.push({ text: item.text, ctx: true, oIdx });
    } else if (item.k === '-') {
      o.push(item.text);
    } else if (item.k === '+') {
      n.push({ text: item.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Build the lines N writes: context lines are the file's own matched lines; at tier 2 the other lines are re-indented. */
function buildN(n: NItem[], o: string[], match: string[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadWs(o[0]!);
    f = leadWs(match[0]!);
  }
  for (const item of n) {
    if (item.ctx) {
      out.push(match[item.oIdx]!);
    } else if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** True when a `\` line immediately follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.k === ' ' || body[i]!.k === '+') last = i;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.k === '\\';
}

/** True when a `\` line immediately follows the body's last `+` line. */
function backslashAfterLastPlus(body: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.k === '+') last = i;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.k === '\\';
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
      tree.now.set(p, text);
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
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------- section 6: unified diffs ----------

interface UHunk {
  a: number;
  body: BodyItem[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function newUSection(gitOld: string | null, gitNew: string | null): USection {
  return { gitOld, gitNew, dashOld: null, dashNew: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, leading a/ or b/ removed. */
function dashPath(s: string): string {
  let t = s.split('\t')[0]!.trim();
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  let cur: USection | null = null;
  let headerDone = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newUSection(m[1]!, m[2]!);
      sections.push(cur);
      headerDone = false;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: Number(hm[1]), body: [] };
      cur.hunks.push(hunk);
      headerDone = true;
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b === '') hunk.body.push({ k: ' ', text: '' });
          else hunk.body.push({ k: b[0] as ' ' | '-' | '+' | '\\', text: b.slice(1) });
          i++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.k === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !headerDone && cur.dashOld === null) {
        cur.dashOld = dashPath(line.slice(4));
        cur.dashNew = dashPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      cur = newUSection(null, null);
      sections.push(cur);
      headerDone = false;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.dashNew = dashPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, ctx));
}

function applyHunks(f: FileLines, hunks: UHunk[], ctx: Ctx, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length > 0) {
      const found = findTierFrom(f.lines, o, 0, ctx.strict);
      if (!found) throw new Fail('no-match', path);
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
      const match = f.lines.slice(best, best + o.length);
      const rep = buildN(n, o, match, found.tier);
      const reachesEof = best + o.length === f.lines.length;
      f.lines.splice(best, o.length, ...rep);
      if (reachesEof) f.final = !backslashAfterLast(h.body);
      d += rep.length - o.length;
    } else {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = at === f.lines.length;
      const rep = n.map((x) => x.text);
      f.lines.splice(at, 0, ...rep);
      if (atEnd) f.final = !backslashAfterLastPlus(h.body);
      d += rep.length;
    }
  }
}

function unifiedSectionEdit(sec: USection, ctx: Ctx): Edit {
  const oldPath = sec.dashOld ?? sec.renameFrom ?? sec.gitOld;
  const newPath = sec.dashNew ?? sec.renameTo ?? sec.gitNew;
  const isCreate = oldPath === '/dev/null' || sec.isCreate;
  const isDelete = newPath === '/dev/null' || sec.isDelete;
  return (tree) => {
    if (oldPath !== '/dev/null' && oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== '/dev/null' && newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const newLines: string[] = [];
      let finalBreak = true;
      let lastPlusHunk: UHunk | null = null;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const item of h.body) {
          if (item.k === '+') {
            newLines.push(item.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlusHunk = h;
      }
      if (lastPlusHunk !== null) finalBreak = !backslashAfterLastPlus(lastPlusHunk.body);
      tree.now.set(np, newLines.length === 0 ? '' : newLines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    if (op !== np) {
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const f = splitFile(before);
      applyHunks(f, sec.hunks, ctx, op);
      tree.now.set(np, joinFile(f));
      tree.now.set(op, null);
      ctx.moves.push([op, np]);
      return;
    }
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const f = splitFile(before);
    applyHunks(f, sec.hunks, ctx, op);
    tree.now.set(op, joinFile(f));
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdits(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let after = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (true) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= after; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, ctx));
    prevPath = path;
    after = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTierFrom(f.lines, oldLines, 0, ctx.strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length !== 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const match = f.lines.slice(at, at + oldLines.length);
    const nItems: NItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = buildN(nItems, oldLines, match, found.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      i++;
      while (i < end) {
        const l = lines[i]!;
        if (isV4aSectionStart(l)) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          fileLines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines, ctx));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(path, ctx));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i;
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let inChunk = false;
      const endChunk = (atSectionEnd: boolean): void => {
        if (cur === null) return;
        if (atSectionEnd) {
          while (cur.body.length > 0) {
            const b = cur.body[cur.body.length - 1]!;
            if (b.k === ' ' && b.text === '') cur.body.pop();
            else break;
          }
        }
        chunks.push(cur);
        cur = null;
        inChunk = false;
      };
      while (i < end) {
        const l = lines[i]!;
        if (isV4aSectionStart(l)) break;
        if (!inChunk) {
          if (blank(l)) {
            i++;
            continue;
          }
          if (l.startsWith('@@')) {
            const anchor = l.slice(2).trim();
            cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
            inChunk = true;
            i++;
            continue;
          }
          if (l === '*** End of File') throw new Exit2(`error: parse ${i + 1}`);
          if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              inChunk = true;
              continue;
            }
            throw new Exit2(`error: parse ${i + 1}`);
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (l.startsWith('@@')) {
          endChunk(false);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          inChunk = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          cur!.eof = true;
          endChunk(false);
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (l === '') cur!.body.push({ k: ' ', text: '' });
          else cur!.body.push({ k: l[0] as ' ' | '-' | '+', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, ctx));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[], ctx: Ctx): Edit {
  void ctx;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string, ctx: Ctx): Edit {
  void ctx;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTierFrom(f.lines, [ch.anchor], cursor, ctx.strict);
        if (!a) throw new Fail('no-match', path);
        cursor = a.pos[0]! + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const rep = n.map((x) => x.text);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else if (ch.eof) {
        const at = f.lines.length - o.length;
        if (at < cursor) throw new Fail('no-match', path);
        const max = ctx.strict ? 0 : 2;
        let found: { tier: number } | null = null;
        for (let t = 0; t <= max; t++) {
          if (matchesAt(f.lines, o, at, t)) {
            found = { tier: t };
            break;
          }
        }
        if (!found) throw new Fail('no-match', path);
        const match = f.lines.slice(at, at + o.length);
        const rep = buildN(n, o, match, found.tier);
        f.lines.splice(at, o.length, ...rep);
        cursor = at + rep.length;
      } else {
        const found = findTierFrom(f.lines, o, cursor, ctx.strict);
        if (!found) throw new Fail('no-match', path);
        const at = found.pos[0]!;
        const match = f.lines.slice(at, at + o.length);
        const rep = buildN(n, o, match, found.tier);
        f.lines.splice(at, o.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, ctx) : kind === 'search-replace' ? srEdits(lines, ctx) : v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (!check) {
    for (const p of changed) {
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
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
