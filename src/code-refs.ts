import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import { toPosix, walkEntries } from './walk.js';

/** Glob patterns used to exclude directories/files from code-ref scanning.
 *  Shared between rg args and the shared isExcluded() path filter. */
const EXCLUDE_DIRS = ['lat.md', '.claude'];
const EXCLUDE_GLOBS = ['*.md'];

/** Every EXCLUDE_GLOBS entry is a `*<suffix>` basename glob. */
const EXCLUDE_SUFFIXES = EXCLUDE_GLOBS.map((g) => g.replace(/^\*/, ''));

/**
 * Wall-clock budget for a single scan subprocess. A scan is a bounded chore,
 * never a reason for a command — or a hook sitting in front of a tool call —
 * to hang: past the budget the child is killed and the scan reports itself
 * skipped rather than grinding on unattended.
 */
export const DEFAULT_SCAN_TIMEOUT_MS = 20_000;

/**
 * Ceiling on files considered in one scan. A tree this large is not a project:
 * the cause is a `lat.md/` adopted above a repository — a home directory, or a
 * node's state root full of backups, logs, and mounted trees — so the honest
 * answer is to refuse and say why, not to walk them.
 */
export const MAX_SCAN_FILES = 50_000;

/**
 * rg skips files larger than this in the content pass. `@lat:` markers live in
 * line comments in source files; without the cap one stray log or model blob
 * dominates the only pass that has to read bytes.
 */
const MAX_FILESIZE = '1M';

/** Why a scan returned no refs without having actually looked. */
export type ScanSkip = {
  reason: 'too-many-files' | 'timed-out' | 'scan-failed';
  message: string;
};

export type CodeRef = {
  target: string;
  file: string;
  line: number;
};

export type ScanResult = {
  refs: CodeRef[];
  files: string[];
  usedRg: boolean;
  /**
   * Set when the scan bailed out. `refs` is then empty because nothing was
   * read — never because nothing was found. A caller that reports a clean
   * result on a skipped scan is reporting a check it never ran.
   */
  skipped?: ScanSkip;
};

/**
 * Directories carrying their own `lat.md/` are sub-projects: their refs belong
 * to their own graph, not this one. Derived from a file list rather than from
 * a dedicated scan, so one traversal answers this and the in-scope file list
 * both.
 */
function findSubProjects(relPaths: string[]): string[] {
  const subProjects = new Set<string>();
  for (const p of relPaths) {
    // "tests/cases/foo/lat.md/specs.md" → "tests/cases/foo". A leading
    // "lat.md/" (this project's own graph) has no parent prefix and is not a
    // sub-project; EXCLUDE_DIRS covers it.
    const i = p.indexOf('/lat.md/');
    if (i !== -1) subProjects.add(p.slice(0, i));
  }
  return [...subProjects];
}

/**
 * The exclusion rules applied to a projectRoot-relative POSIX path. One
 * predicate for both scan paths, mirroring the `--glob` args rg gets for the
 * content pass — so the reported file list and the searched set are the same
 * set however the scan ran.
 */
function isExcluded(rel: string, subProjects: string[]): boolean {
  const dirs = rel.split('/').slice(0, -1);
  if (dirs.some((d) => EXCLUDE_DIRS.includes(d))) return true;
  if (EXCLUDE_SUFFIXES.some((s) => rel.endsWith(s))) return true;
  return subProjects.some((sp) => rel.startsWith(sp + '/'));
}

/** Walk project files for code-ref scanning. Uses walkEntries for .gitignore
 *  support, then applies the shared isExcluded() filter. */
export async function walkFiles(dir: string): Promise<string[]> {
  const entries = await walkEntries(dir);
  const subProjects = findSubProjects(entries);
  return entries
    .filter((e) => !isExcluded(e, subProjects))
    .map((e) => join(dir, e));
}

/** Build a RegExp from a verbose template — whitespace is insignificant. */
function re(flags: string) {
  return (strings: TemplateStringsArray) =>
    new RegExp(strings.raw[0].replace(/\s+/g, ''), flags);
}

// Line comment (//, #, or --), then @lat: marker, then [[target]].
// `--` covers SQL; the other two cover C-family + Python/shell.
export const LAT_REF_RE = re('gv')`
  (?: // | -- | # )
  \s* @lat: \s*
  \[\[
    ( [^\]]+ )
  \]\]
`;

type ExecOutcome =
  | { ok: true; out: string }
  | { ok: false; kind: 'missing' | 'timed-out' | 'failed'; detail: string };

/** execFile's error carries a numeric exit code, which ErrnoException does not
 *  model; `killed`/`signal` are how a timeout kill reports itself. */
type ExecError = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
};

/**
 * Run an external command under a wall-clock budget.
 *
 * The `kind` on failure is load-bearing: only 'missing' means "this tool isn't
 * here, try another way". A timed-out or failed scan must NOT be retried by a
 * slower path over the same tree — that turns a bounded subprocess into an
 * unbounded one.
 */
function tryExec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs },
      (err, out, stderr) => {
        if (!err) {
          resolve({ ok: true, out });
          return;
        }
        const e = err as ExecError;
        if (e.code === 'ENOENT') {
          resolve({ ok: false, kind: 'missing', detail: `${cmd} not on PATH` });
          return;
        }
        // rg/grep exit 1 = "no matches": a completed search with an empty
        // result, not a failure. Misreading it as one used to drop every
        // ref-free tree onto the TS fallback, which then re-read the whole
        // tree in-process — the slow path, chosen precisely when rg had
        // already done the job.
        if (e.code === 1) {
          resolve({ ok: true, out: out ?? '' });
          return;
        }
        const killed = e.killed === true || e.signal != null;
        resolve({
          ok: false,
          kind: killed ? 'timed-out' : 'failed',
          detail: killed
            ? `${cmd} exceeded its ${Math.round(timeoutMs / 1000)}s budget`
            : (stderr || '').split('\n')[0] || e.message.split('\n')[0],
        });
      },
    );
  });
}

/** Build rg glob exclusion args. */
function rgExcludeArgs(subProjects: string[]): string[] {
  const args: string[] = [];
  for (const dir of EXCLUDE_DIRS) args.push('--glob', `!${dir}/`);
  for (const glob of EXCLUDE_GLOBS) args.push('--glob', `!${glob}`);
  for (const sp of subProjects) args.push('--glob', `!${sp}/`);
  return args;
}

function skipped(reason: ScanSkip['reason'], message: string): ScanResult {
  return { refs: [], files: [], usedRg: true, skipped: { reason, message } };
}

/**
 * Scan with ripgrep. Returns null — and only null — when rg is not installed,
 * which is the one failure the TS fallback can answer.
 *
 * Two passes, not three: one `rg --files` supplies both the sub-project list
 * and the in-scope file list, then one content pass reads bytes. `.gitignore`
 * rules are honoured with `--no-require-git`, since rg otherwise ignores them
 * outright whenever the scan root is not itself inside a git repository.
 */
async function tryRipgrep(
  projectRoot: string,
  timeoutMs: number,
  maxFiles: number,
): Promise<ScanResult | null> {
  const listed = await tryExec(
    'rg',
    ['--files', '--no-require-git', '.'],
    projectRoot,
    timeoutMs,
  );
  if (!listed.ok) {
    if (listed.kind === 'missing') return null;
    return skipped(
      listed.kind === 'timed-out' ? 'timed-out' : 'scan-failed',
      `listing files under ${projectRoot} failed: ${listed.detail}`,
    );
  }

  const all = listed.out
    .split('\n')
    .filter(Boolean)
    .map((f) => toPosix(f).replace(/^\.\//, ''));

  if (all.length > maxFiles) {
    return skipped(
      'too-many-files',
      `${all.length} files under ${projectRoot} (limit ${maxFiles})`,
    );
  }

  const subProjects = findSubProjects(all);
  const files = all
    .filter((f) => !isExcluded(f, subProjects))
    .map((f) => join(projectRoot, f));

  const searched = await tryExec(
    'rg',
    [
      '--no-heading',
      '--line-number',
      '--with-filename',
      '--no-require-git',
      '--max-filesize',
      MAX_FILESIZE,
      ...rgExcludeArgs(subProjects),
      '@lat:.*\\[\\[',
      '.',
    ],
    projectRoot,
    timeoutMs,
  );
  if (!searched.ok) {
    if (searched.kind === 'missing') return null;
    return skipped(
      searched.kind === 'timed-out' ? 'timed-out' : 'scan-failed',
      `searching ${projectRoot} failed: ${searched.detail}`,
    );
  }

  return { refs: parseGrepOutput(searched.out), files, usedRg: true };
}

/**
 * Parse rg output lines (file:line:content) into CodeRef entries.
 */
function parseGrepOutput(output: string): CodeRef[] {
  const refs: CodeRef[] = [];

  if (!output.trim()) return refs;

  for (const line of output.split('\n')) {
    if (!line) continue;
    // Format: ./path/to/file:linenum:content
    const firstColon = line.indexOf(':');
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon === -1) continue;

    // rg emits native separators (`\` on Windows); normalize to POSIX so the
    // stored path matches wiki-link and TS-fallback conventions. This also
    // turns a Windows `.\` prefix into `./` for the strip below.
    let filePath = toPosix(line.slice(0, firstColon));
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const content = line.slice(secondColon + 1);

    if (isNaN(lineNum)) continue;

    // Strip leading ./ from path
    if (filePath.startsWith('./')) filePath = filePath.slice(2);

    // Extract targets using the same regex as the TS fallback
    LAT_REF_RE.lastIndex = 0;
    let match;
    while ((match = LAT_REF_RE.exec(content)) !== null) {
      refs.push({ target: match[1], file: filePath, line: lineNum });
    }
  }

  return refs;
}

/**
 * TypeScript fallback: read every file and scan for @lat refs.
 */
async function scanWithTs(
  files: string[],
  projectRoot: string,
): Promise<CodeRef[]> {
  const refs: CodeRef[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `Error: failed to read ${file}: ${(err as Error).message}\n`,
      );
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let match;
      LAT_REF_RE.lastIndex = 0;
      while ((match = LAT_REF_RE.exec(lines[i])) !== null) {
        refs.push({
          target: match[1],
          file: toPosix(relative(projectRoot, file)),
          line: i + 1,
        });
      }
    }
  }

  return refs;
}

/**
 * Fallback for hosts without ripgrep: walk the tree, then read every file.
 * The file ceiling is enforced before the reads, which are the expensive half.
 */
async function scanWithWalk(
  projectRoot: string,
  maxFiles: number,
): Promise<ScanResult> {
  const files = await walkFiles(projectRoot);
  if (files.length > maxFiles) {
    return {
      ...skipped(
        'too-many-files',
        `${files.length} files under ${projectRoot} (limit ${maxFiles})`,
      ),
      usedRg: false,
    };
  }
  const refs = await scanWithTs(files, projectRoot);
  return { refs, files, usedRg: false };
}

/** Check whether ripgrep (`rg`) is available on PATH. */
export async function hasRipgrep(): Promise<boolean> {
  const result = await tryExec('rg', ['--version'], '.', 5_000);
  return result.ok;
}

export async function scanCodeRefs(
  projectRoot: string,
  opts: { timeoutMs?: number; maxFiles?: number } = {},
): Promise<ScanResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES;

  // Fast path: rg for both file listing and searching.
  // _LAT_DISABLE_RG is a test-only escape hatch to force the TS fallback
  if (process.env._LAT_DISABLE_RG !== '1') {
    const rgResult = await tryRipgrep(projectRoot, timeoutMs, maxFiles);
    if (rgResult !== null) return rgResult;
  }

  return scanWithWalk(projectRoot, maxFiles);
}
