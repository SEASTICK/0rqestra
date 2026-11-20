import vm from "node:vm";

// Stage 3: what a reviewer reads first is the change, not the whole file again, and output that is
// plainly broken is caught here before a reviewer is asked at all.

const MAX_LINES = 1500;

// A unified diff with a few lines of context, or null when the files are too long to compare here.
export function unifiedDiff(path: string, before: string, after: string, context = 3): string | null {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  // Longest common subsequence table (fine for files of this size).
  const n = a.length, m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { op: " " | "-" | "+"; line: string; ai: number; bi: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ op: " ", line: a[i]!, ai: i, bi: j }); i += 1; j += 1; }
    // Removed lines before added ones, as diffs usually show them.
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ op: "-", line: a[i]!, ai: i, bi: j }); i += 1; }
    else { ops.push({ op: "+", line: b[j]!, ai: i, bi: j }); j += 1; }
  }
  const changed = ops.map((o, k) => (o.op !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return `--- ${path}\n+++ ${path}\n(no changes)`;
  const out = [`--- ${path} (before)`, `+++ ${path} (after)`];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k]! - context);
    let end = Math.min(ops.length - 1, changed[k]! + context);
    while (k + 1 < changed.length && changed[k + 1]! - context <= end + 1) { k += 1; end = Math.min(ops.length - 1, changed[k]! + context); }
    const hunk = ops.slice(start, end + 1);
    out.push(`@@ -${hunk[0]!.ai + 1} +${hunk[0]!.bi + 1} @@`, ...hunk.map((o) => `${o.op}${o.line}`));
    k += 1;
  }
  return out.join("\n");
}

// Problems the runner can see without a model: JSON that does not parse, and JavaScript that is
// not valid syntax (checked by compiling only; nothing is run).
export function outputProblems(files: { path: string; content: string }[]): string[] {
  const problems: string[] = [];
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (lower.endsWith(".json")) {
      try {
        JSON.parse(f.content);
      } catch (error) {
        problems.push(`${f.path} is not valid JSON: ${(error as Error).message.slice(0, 160)}`);
      }
    } else if ((lower.endsWith(".js") || lower.endsWith(".cjs")) && !/^\s*(import|export)\s/m.test(f.content)) {
      try {
        // Compiled as a CommonJS module body would be (so a top-level return is fine); never called.
        vm.compileFunction(f.content, ["exports", "require", "module", "__filename", "__dirname"], { filename: f.path });
      } catch (error) {
        problems.push(`${f.path} has a syntax error: ${(error as Error).message.slice(0, 160)}`);
      }
    }
  }
  return problems;
}
