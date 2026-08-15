import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { findLatticeDir } from '../lattice.js';
import { plainStyler, type CmdContext } from '../context.js';
import { expandPrompt } from './expand.js';
import { runSearch } from './search.js';
import { getSection, formatSectionOutput } from './section.js';
import { checkMd, checkCodeRefs, checkIndex, checkSections } from './check.js';
import { SOURCE_EXTENSIONS } from '../source-parser.js';

function outputClaudePromptSubmit(context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    }),
  );
}

function outputClaudeStop(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
    }),
  );
}

function outputCursorStop(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      followup_message: reason,
    }),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function hasWikiLinks(text: string): boolean {
  return /\[\[[^\]]+\]\]/.test(text);
}

function makeHookCtx(latDir: string): CmdContext {
  return {
    latDir,
    projectRoot: dirname(latDir),
    styler: plainStyler,
    mode: 'cli',
  };
}

async function searchAndExpand(
  ctx: CmdContext,
  userPrompt: string,
): Promise<string | null> {
  let result;
  try {
    // Read-only: search an existing index but never build/update it here. A fresh
    // repo's first prompt must not trigger a full local embed pass — that's what
    // `lat search` / `lat reindex` are for. Returns no matches until then.
    result = await runSearch(ctx.latDir, userPrompt, 5, undefined, {
      buildIndex: false,
    });
  } catch {
    // No usable backend (e.g. reindex required, key rejected) — skip semantic
    // enrichment silently rather than blocking the user's prompt.
    return null;
  }
  if (result.matches.length === 0) return null;

  const parts: string[] = [
    `Search results for the user prompt (${result.matches.length} matches):`,
    '',
  ];

  for (const match of result.matches) {
    const sectionResult = await getSection(ctx, match.section.id);
    if (sectionResult.kind === 'found') {
      parts.push(formatSectionOutput(ctx, sectionResult));
      parts.push('');
    }
  }

  return parts.join('\n');
}

async function handleUserPromptSubmit(): Promise<void> {
  let userPrompt = '';
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    userPrompt = input.user_prompt ?? '';
  } catch {
    // If we can't parse stdin, still emit the reminder
  }

  const parts: string[] = [];

  parts.push(
    'If this prompt starts NEW work in this repo (implementing, debugging, reviewing, or planning a change), orient before reading source: `lat search` with queries describing the intent, then `lat section` on relevant hits — the graph holds design law the code cannot show.',
    'Skip the search for conversational follow-ups, questions about content already in context, and non-repo tasks — searching there is noise, not diligence.',
    '',
    'Remember: `lat.md/` must stay in sync with the codebase. If you change code or behavior, update the relevant `lat.md/` sections and run `lat check` before finishing.',
  );

  const latDir = findLatticeDir();
  if (latDir && userPrompt) {
    const ctx = makeHookCtx(latDir);

    // If the user prompt contains [[refs]], resolve them inline
    if (hasWikiLinks(userPrompt)) {
      try {
        const expanded = await expandPrompt(ctx, userPrompt);
        if (expanded) {
          parts.push(
            '',
            'Expanded user prompt with resolved [[refs]]:',
            expanded,
          );
        } else {
          parts.push(
            '',
            'NOTE: The user prompt contains [[refs]] but they could not be resolved. Ask the user to correct them.',
          );
        }
      } catch {
        parts.push(
          '',
          'NOTE: The user prompt contains [[refs]] but resolution failed. Run `lat expand` on the prompt text manually.',
        );
      }
    }

    // Search for relevant sections and include their full content
    try {
      const searchContext = await searchAndExpand(ctx, userPrompt);
      if (searchContext) {
        parts.push('', searchContext);
      }
    } catch {
      // Search failed (no key, index error, etc.) — agent can search manually
    }
  }

  outputClaudePromptSubmit(parts.join('\n'));
}

/** Minimum diff size (in lines) to consider "significant" code change. */
/** Minimum code change size (lines) before we consider flagging lat.md/ sync. */
const DIFF_THRESHOLD = 5;

/** lat.md/ changes below this ratio of code changes trigger a sync reminder. */
const LATMD_RATIO = 0.05;

/** If lat.md/ changes exceed this many lines, skip the ratio check entirely. */
const LATMD_UPPER_THRESHOLD = 50;

type DiffEntry = { file: string; changed: number; isLat: boolean };

/** Run `git diff HEAD --numstat` and return one entry per counted file. */
function analyzeDiff(projectRoot: string): DiffEntry[] {
  let output: string;
  try {
    // stderr ignored: git emits advisory warnings (e.g. CRLF conversion) that
    // would otherwise leak into the agent-facing hook stderr.
    output = execSync('git diff HEAD --numstat', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const entries: DiffEntry[] = [];

  // Each line: "added\tremoved\tfile" (e.g. "42\t11\tsrc/cli/hook.ts")
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parseInt(parts[0], 10) || 0;
    const removed = parseInt(parts[1], 10) || 0;
    const file = parts[2];
    if (file.startsWith('lat.md/')) {
      entries.push({ file, changed: added + removed, isLat: true });
    } else if (SOURCE_EXTENSIONS.has(extname(file))) {
      entries.push({ file, changed: added + removed, isLat: false });
    }
  }

  return entries;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function touchedHas(touched: Set<string>, repoRelFile: string): boolean {
  const rel = normPath(repoRelFile);
  for (const t of touched) {
    if (t === rel || t.endsWith('/' + rel)) return true;
  }
  return false;
}

/** Tool names whose file_path input means the session WROTE that file. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Files this session edited, from its transcript (write-tool calls only —
 * a Read of someone else's dirty file is not authorship). Returns null when
 * no transcript is available, which disables attribution and preserves the
 * unfiltered nag. Heuristic: edits made through shell commands are invisible
 * here and simply don't count toward the session's sync debt.
 */
function sessionTouchedFiles(
  transcriptPath: string | undefined,
): Set<string> | null {
  if (!transcriptPath) return null;
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (obj as { message?: { content?: unknown } })?.message
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (
        item?.type === 'tool_use' &&
        WRITE_TOOLS.has(item?.name) &&
        typeof item?.input?.file_path === 'string'
      ) {
        out.add(normPath(item.input.file_path));
      }
    }
  }
  return out;
}

/**
 * Tally diff lines, restricted to files this session edited when a transcript
 * is available (touched !== null). On a shared working tree another session's
 * in-flight diff must not nag this one — the sync debt follows authorship.
 */
function tallyDiff(
  entries: DiffEntry[],
  touched: Set<string> | null,
): { codeLines: number; latMdLines: number } {
  let codeLines = 0;
  let latMdLines = 0;
  for (const e of entries) {
    if (touched !== null && !touchedHas(touched, e.file)) continue;
    if (e.isLat) latMdLines += e.changed;
    else codeLines += e.changed;
  }
  return { codeLines, latMdLines };
}

type StopStatus = {
  checkFailed: boolean;
  totalErrors: number;
  needsSync: boolean;
  codeLines: number;
  latMdLines: number;
};

async function getStopStatus(
  latDir: string,
  touched: Set<string> | null = null,
): Promise<StopStatus> {
  const md = await checkMd(latDir);
  const code = await checkCodeRefs(latDir);
  const indexErrors = await checkIndex(latDir);
  const sectionErrors = await checkSections(latDir);
  const totalErrors =
    md.errors.length +
    code.errors.length +
    indexErrors.length +
    sectionErrors.length;
  const checkFailed = totalErrors > 0;

  const projectRoot = dirname(latDir);
  const { codeLines, latMdLines } = tallyDiff(analyzeDiff(projectRoot), touched);
  let needsSync = false;
  if (codeLines >= DIFF_THRESHOLD && latMdLines < LATMD_UPPER_THRESHOLD) {
    const effectiveLatMd = latMdLines === 0 ? 0 : Math.max(latMdLines, 1);
    needsSync = effectiveLatMd < codeLines * LATMD_RATIO;
  }

  return {
    checkFailed,
    totalErrors,
    needsSync,
    codeLines,
    latMdLines,
  };
}

function formatStopReason({
  checkFailed,
  totalErrors,
  needsSync,
  codeLines,
  latMdLines,
}: StopStatus): string | null {
  if (!checkFailed && !needsSync) return null;

  const parts: string[] = [];

  const syncMsg =
    latMdLines === 0
      ? 'The codebase has changes (' +
        codeLines +
        ' lines) but `lat.md/` was not updated.'
      : 'The codebase has changes (' +
        codeLines +
        ' lines) but `lat.md/` may not be fully in sync (' +
        latMdLines +
        ' lines changed).';

  if (checkFailed && needsSync) {
    parts.push(
      '`lat check` found errors. ' + syncMsg + ' Before finishing:',
      '',
      '1. Update `lat.md/` to reflect your code changes — run `lat search` to find relevant sections.',
      '2. Run `lat check` until it passes.',
    );
  } else if (checkFailed) {
    parts.push(
      '`lat check` found ' +
        totalErrors +
        ' error(s). Run `lat check`, fix the errors, and repeat until it passes.',
    );
  } else {
    parts.push(
      syncMsg +
        ' Verify `lat.md/` is in sync — run `lat search` to find relevant sections. Run `lat check` at the end.',
    );
  }

  return parts.join('\n');
}

async function handleClaudeStop(): Promise<void> {
  const latDir = findLatticeDir();
  if (!latDir) return;

  // Read stdin: stop_hook_active (already blocked once) and transcript_path
  // (session attribution — only this session's edits count toward sync debt).
  let stopHookActive = false;
  let transcriptPath: string | undefined;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    stopHookActive = input.stop_hook_active ?? false;
    if (typeof input.transcript_path === 'string')
      transcriptPath = input.transcript_path;
  } catch {
    // If we can't parse stdin, treat as first attempt
  }

  const status = await getStopStatus(latDir, sessionTouchedFiles(transcriptPath));

  // Second pass — warn the user but don't block again
  if (stopHookActive) {
    if (status.checkFailed) {
      console.error(
        `lat check is still failing (${status.totalErrors} error(s)). Run \`lat check\` to see details.`,
      );
    }
    return;
  }

  const reason = formatStopReason(status);
  if (!reason) return;
  outputClaudeStop(reason);
}

async function handleCursorStop(): Promise<void> {
  const latDir = findLatticeDir();
  if (!latDir) return;

  const reason = formatStopReason(await getStopStatus(latDir));
  if (!reason) return;
  outputCursorStop(reason);
}

export async function hookCmd(agent: string, event: string): Promise<void> {
  switch (agent) {
    case 'claude':
      switch (event) {
        case 'UserPromptSubmit':
          await handleUserPromptSubmit();
          return;
        case 'Stop':
          await handleClaudeStop();
          return;
        default:
          console.error(
            `Unknown hook event for claude: ${event}. Supported: UserPromptSubmit, Stop`,
          );
          process.exit(1);
      }
    case 'cursor':
      switch (event) {
        case 'stop':
          await handleCursorStop();
          return;
        default:
          console.error(
            `Unknown hook event for cursor: ${event}. Supported: stop`,
          );
          process.exit(1);
      }
    default:
      console.error(`Unknown agent: ${agent}. Supported: claude, cursor`);
      process.exit(1);
  }
}
