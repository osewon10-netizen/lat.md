import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
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

  // Budget the injection: full sections can run tens of KB per prompt, and
  // this fires on EVERY prompt — omitted matches stay one `lat section` away.
  let used = 0;
  let included = 0;
  for (const match of result.matches) {
    const sectionResult = await getSection(ctx, match.section.id);
    if (sectionResult.kind !== 'found') continue;
    const block = formatSectionOutput(ctx, sectionResult);
    if (included > 0 && used + block.length > SEARCH_CONTEXT_BUDGET) break;
    parts.push(block, '');
    used += block.length;
    included++;
  }
  const omitted = result.matches.length - included;
  if (omitted > 0) {
    parts.push(
      `(${omitted} lower-ranked match(es) omitted for context budget — run \`lat search\` and \`lat section\` to read them.)`,
    );
  }

  return parts.join('\n');
}

/** Char budget for the per-prompt search injection. */
const SEARCH_CONTEXT_BUDGET = 8000;

/**
 * Per-session fire budget for a hook surface, as a counter file in the OS
 * tmpdir keyed by session + repo + surface. Returns true (and increments)
 * while under the limit. HARD CEILING: no hook surface speaks more than
 * twice per session — repeated hook text is context an agent pays for on
 * every subsequent request. No session id fails open (fires every time).
 */
const MAX_FIRES_PER_SESSION = 2;

function tryFire(
  sessionId: string,
  latDir: string,
  surface: string,
  limit = 1,
): boolean {
  if (!sessionId) return true;
  const capped = Math.min(limit, MAX_FIRES_PER_SESSION);
  const key = createHash('sha1')
    .update(sessionId + '\0' + latDir + '\0' + surface)
    .digest('hex')
    .slice(0, 16);
  const path = join(tmpdir(), 'lat-hookfire-' + key);
  let count = 0;
  try {
    count = parseInt(readFileSync(path, 'utf-8'), 10) || 0;
  } catch {
    // No counter yet.
  }
  if (count >= capped) return false;
  try {
    writeFileSync(path, String(count + 1));
  } catch {
    // Unwritable tmpdir just means we may fire again next time.
  }
  return true;
}

async function handleUserPromptSubmit(): Promise<void> {
  let userPrompt = '';
  let sessionId: string | undefined;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    userPrompt = input.user_prompt ?? '';
    if (typeof input.session_id === 'string') sessionId = input.session_id;
  } catch {
    // If we can't parse stdin, still emit the reminder
  }

  const parts: string[] = [];
  const latDir = findLatticeDir();

  if (tryFire(sessionId ?? '', latDir ?? '', 'prompt-reminder', 1)) {
    parts.push(
      'If this prompt starts NEW work in this repo (implementing, debugging, reviewing, or planning a change), orient before reading source: `lat search` with queries describing the intent, then `lat section` on relevant hits — the graph holds design law the code cannot show.',
      'Skip the search for conversational follow-ups, questions about content already in context, and non-repo tasks — searching there is noise, not diligence.',
      '',
      'Remember: `lat.md/` must stay in sync with the codebase. If you change code or behavior, update the relevant `lat.md/` sections and run `lat check` before finishing.',
    );
  }
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

  const context = parts.join('\n').replace(/^\n+/, '');
  if (!context) return;
  outputClaudePromptSubmit(context);
}

/** Minimum diff size (in lines) to consider "significant" code change. */
/** Minimum code change size (lines) before we consider flagging lat.md/ sync. */
const DIFF_THRESHOLD = 5;

/** lat.md/ changes below this ratio of code changes trigger a sync reminder. */
const LATMD_RATIO = 0.05;

/** If lat.md/ changes exceed this many lines, skip the ratio check entirely. */
const LATMD_UPPER_THRESHOLD = 50;

type DiffEntry = { file: string; changed: number; isLat: boolean };

/**
 * Run git numstat and return one entry per counted file. Default scope is the
 * whole working tree vs HEAD; `staged` restricts to the index (`--cached`) —
 * what the imminent commit actually ships, which needs no session attribution.
 */
function analyzeDiff(projectRoot: string, staged = false): DiffEntry[] {
  let output: string;
  try {
    // stderr ignored: git emits advisory warnings (e.g. CRLF conversion) that
    // would otherwise leak into the agent-facing hook stderr.
    output = execSync(
      staged ? 'git diff --cached --numstat' : 'git diff HEAD --numstat',
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
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

/**
 * A Bash command that creates a git commit. Segment-wise so `GIT_SSH=... git
 * push && git commit` chains are judged per segment; modest false positives
 * (e.g. `git log --grep commit`) are tolerable — the gate only speaks when
 * staged code has lat.md debt, and yields after one nudge per staged state.
 */
function isGitCommitCommand(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (/\bgit\b/.test(segment) && /\bcommit\b/.test(segment)) return true;
  }
  return false;
}

/**
 * PreToolUse (attach via settings matcher to Bash): when the command is a git
 * commit and the STAGED diff has code changes without a proportional lat.md
 * update, deny once with the fold reminder — the moment the agent can still
 * stage the fold into the same commit. Re-running the commit proceeds: one
 * nudge per staged state per session, never a hard wall.
 */
async function handleClaudePreToolUse(): Promise<void> {
  let sessionId = '';
  let toolName = '';
  let command = '';
  let transcriptPath: string | undefined;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    if (typeof input.session_id === 'string') sessionId = input.session_id;
    toolName = input.tool_name ?? '';
    command = input.tool_input?.command ?? '';
    if (typeof input.transcript_path === 'string')
      transcriptPath = input.transcript_path;
  } catch {
    return;
  }
  if (toolName !== 'Bash') return;

  const latDir = findLatticeDir();
  if (!latDir) return;

  if (isGitCommitCommand(command)) {
    await commitSyncGate(latDir, sessionId);
  } else if (isGitPushCommand(command)) {
    await pushChecks(latDir, sessionId, sessionTouchedFiles(transcriptPath));
  }
}

async function commitSyncGate(
  latDir: string,
  sessionId: string,
): Promise<void> {
  const { codeLines, latMdLines } = tallyDiff(
    analyzeDiff(dirname(latDir), true),
    null,
  );
  let needsSync = false;
  if (codeLines >= DIFF_THRESHOLD && latMdLines < LATMD_UPPER_THRESHOLD) {
    const effectiveLatMd = latMdLines === 0 ? 0 : Math.max(latMdLines, 1);
    needsSync = effectiveLatMd < codeLines * LATMD_RATIO;
  }
  if (!needsSync) return;

  // Identical staged state retried = deliberate proceed: yield silently and
  // WITHOUT consuming the session's fire budget.
  const stagedSig = createHash('sha1')
    .update(sessionId + '\0' + codeLines + ':' + latMdLines)
    .digest('hex')
    .slice(0, 16);
  const marker = join(tmpdir(), 'lat-commit-nudge-' + stagedSig);
  if (existsSync(marker)) return;

  if (!tryFire(sessionId, latDir, 'commit-gate', MAX_FIRES_PER_SESSION)) return;
  try {
    writeFileSync(marker, '');
  } catch {
    // Unwritable tmpdir: nudge again next time rather than block repeatedly.
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `This commit stages ${codeLines} code line(s) with ${latMdLines === 0 ? 'no' : 'only ' + latMdLines + ' line(s) of'} lat.md/ update. ` +
          'If the change alters behavior, architecture, or tests, fold the durable invariant into `lat.md/` and stage it with this commit (then `lat check`). ' +
          'If the fold genuinely belongs elsewhere (docs-only stack, fold lands in a later commit of this push), just re-run the commit — this gate yields after one nudge per staged state.',
      },
    }),
  );
}

/** A Bash command that pushes to a remote, judged per segment like commits. */
function isGitPushCommand(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (/\bgit\b/.test(segment) && /\bpush\b/.test(segment)) return true;
  }
  return false;
}

/**
 * Push-time checks. (1) Stranded fold: uncommitted lat.md/ changes at push
 * time mean a fold was written but not committed — folds land BEFORE the
 * push; deny once, yield on retry. (2) Co-tenant manifest: inject the
 * unpushed-commit list so the agent eyeballs exactly what it is about to
 * ship on a shared tree (advisory allow; ignored harmlessly by harnesses
 * without PreToolUse additionalContext support).
 */
async function pushChecks(
  latDir: string,
  sessionId: string,
  touched: Set<string> | null,
): Promise<void> {
  const root = dirname(latDir);
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };

  // Same authorship rule as the Stop hook: on a shared tree, another
  // session's dirty lat.md topics are not this session's stranded fold.
  const stranded = run('git status --porcelain -- lat.md/')
    .split('\n')
    .filter((line) => {
      const file = line.slice(3).split(' -> ').pop()?.trim() ?? '';
      if (!file) return false;
      return touched === null || touchedHas(touched, file);
    })
    .join('\n')
    .trim();
  if (stranded) {
    const sig = createHash('sha1')
      .update(sessionId + '\0' + stranded)
      .digest('hex')
      .slice(0, 16);
    const marker = join(tmpdir(), 'lat-push-nudge-' + sig);
    if (!existsSync(marker) && tryFire(sessionId, latDir, 'push-gate', MAX_FIRES_PER_SESSION)) {
      try {
        writeFileSync(marker, '');
      } catch {
        // Unwritable tmpdir: nudge again next time.
      }
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'Uncommitted lat.md/ changes at push time — the fold lands BEFORE the push:\n' +
              stranded +
              '\nCommit the fold (and run `lat check`), or re-run the push to proceed as-is.',
          },
        }),
      );
      return;
    }
  }

  const unpushed = run('git log @{upstream}..HEAD --oneline').trim();
  if (unpushed && tryFire(sessionId, latDir, 'push-manifest', MAX_FIRES_PER_SESSION)) {
    // No permissionDecision: an 'allow' would silently bypass the user's
    // permission prompt for the push — context only, permission flow untouched.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext:
            'About to push these commits (shared tree — verify every one is yours):\n' +
            unpushed,
        },
      }),
    );
  }
}

/**
 * PostToolUse (attach via settings matcher to work-start tools, e.g. a queue
 * read or an item claim): inject the lat orientation reminder at the moment an
 * item is actually picked up. Once per session.
 */
async function handleClaudePostToolUse(): Promise<void> {
  let sessionId = '';
  let toolName = '';
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    if (typeof input.session_id === 'string') sessionId = input.session_id;
    toolName = input.tool_name ?? '';
  } catch {
    return;
  }

  const latDir = findLatticeDir();
  if (!latDir) return;

  if (!tryFire(sessionId, latDir, 'work-start', 1)) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          `Work item picked up (${toolName || 'queue tool'}). Before reading source for it: \`lat search\` the item's intent, then \`lat section\` on the relevant hits — the graph holds design law the code cannot show.`,
          'When the change lands: fold durable invariants into `lat.md/` and get `lat check` green before the push.',
        ].join('\n'),
      },
    }),
  );
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
        case 'PreToolUse':
          await handleClaudePreToolUse();
          return;
        case 'PostToolUse':
          await handleClaudePostToolUse();
          return;
        default:
          console.error(
            `Unknown hook event for claude: ${event}. Supported: UserPromptSubmit, Stop, PreToolUse, PostToolUse`,
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
