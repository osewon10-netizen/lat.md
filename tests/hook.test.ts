import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmDirBestEffort } from './util.js';

const casesDir = join(import.meta.dirname, 'cases');
const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

/** Build a numstat string from [added, removed, file] tuples. */
function numstat(files: [number, number, string][]): string {
  return files.map(([a, r, f]) => `${a}\t${r}\t${f}`).join('\n');
}

/**
 * Create a temp dir with a fake `git` that prints the given numstat regardless
 * of args. Cross-platform: the payload is stored in a data file (preserving the
 * tab separators), and both a POSIX `git` shell script and a Windows `git.cmd`
 * batch shim emit it — so the hook's `git diff --numstat` is intercepted on
 * every OS. Callers prepend this dir to PATH.
 */
function makeFakeGitDir(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-hook-'));
  const dataFile = join(dir, 'numstat.txt');
  writeFileSync(dataFile, output);

  // POSIX: `git` shell script.
  const shScript = join(dir, 'git');
  writeFileSync(shScript, '#!/bin/sh\ncat "$(dirname "$0")/numstat.txt"\n');
  chmodSync(shScript, 0o755);

  // Windows: `git.cmd` batch shim (resolved via PATHEXT). `type` preserves tabs.
  const cmdScript = join(dir, 'git.cmd');
  writeFileSync(cmdScript, '@type "%~dp0numstat.txt"\r\n');

  return dir;
}

/**
 * Write a fake Claude Code transcript (JSONL) whose assistant messages carry
 * the given tool_use calls. Returns the transcript file path; the caller's
 * temp dir owns cleanup.
 */
function makeTranscript(
  dir: string,
  calls: { name: string; file_path: string }[],
): string {
  const lines = calls.map((c) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: c.name, input: { file_path: c.file_path } }],
      },
    }),
  );
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

/** Run `lat hook <agent> <event>` against a test case dir. */
function runHook(
  agent: string,
  event: string,
  caseDir: string,
  opts: {
    stopHookActive?: boolean;
    fakeBinDir?: string;
    transcriptPath?: string;
    userPrompt?: string;
    sessionId?: string;
    toolName?: string;
    toolCommand?: string;
  } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const stdinJson = JSON.stringify({
    stop_hook_active: opts.stopHookActive ?? false,
    ...(opts.transcriptPath ? { transcript_path: opts.transcriptPath } : {}),
    ...(opts.userPrompt ? { user_prompt: opts.userPrompt } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(opts.toolName ? { tool_name: opts.toolName } : {}),
    ...(opts.toolCommand ? { tool_input: { command: opts.toolCommand } } : {}),
  });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (opts.fakeBinDir) {
    // Prepend using the OS path delimiter (';' on Windows). Windows env vars are
    // case-insensitive, so drop any existing `Path` key before setting `PATH` to
    // avoid the child inheriting the unmodified value under a different casing.
    const orig = env.PATH ?? env.Path ?? '';
    delete env.Path;
    delete env.PATH;
    env.PATH = opts.fakeBinDir + delimiter + orig;
  }

  const result = spawnSync('node', [cliPath, 'hook', agent, event], {
    cwd: caseDir,
    encoding: 'utf-8',
    input: stdinJson,
    env,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function runStopHook(
  agent: 'claude' | 'cursor',
  caseDir: string,
  opts: {
    stopHookActive?: boolean;
    fakeBinDir?: string;
    transcriptPath?: string;
  } = {},
): { stdout: string; stderr: string; exitCode: number } {
  return runHook(agent, agent === 'claude' ? 'Stop' : 'stop', caseDir, opts);
}

const clean = join(casesDir, 'hook-clean');
const broken = join(casesDir, 'error-broken-links');

function uniqueSessionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('hook prompt submit', () => {
  // @lat: [[tests/hook#Reminder emitted once per session]]
  it('emits the static reminder on the first prompt of a session only', () => {
    const sessionId = uniqueSessionId();
    const first = runHook('claude', 'UserPromptSubmit', clean, {
      userPrompt: 'do a thing',
      sessionId,
    });
    expect(first.stdout).toContain('lat search');
    expect(first.stdout).toContain('stay in sync');

    const second = runHook('claude', 'UserPromptSubmit', clean, {
      userPrompt: 'another thing',
      sessionId,
    });
    expect(second.stdout).not.toContain('stay in sync');
  });

  // @lat: [[tests/hook#Missing session id reminds every prompt]]
  it('reminds on every prompt when no session_id is supplied', () => {
    for (let i = 0; i < 2; i++) {
      const { stdout } = runHook('claude', 'UserPromptSubmit', clean, {
        userPrompt: 'do a thing',
      });
      expect(stdout).toContain('stay in sync');
    }
  });

  // @lat: [[tests/hook#Distinct sessions each get one reminder]]
  it('a second session still gets its own first-prompt reminder', () => {
    const a = uniqueSessionId();
    const b = uniqueSessionId();
    runHook('claude', 'UserPromptSubmit', clean, { userPrompt: 'x', sessionId: a });
    const { stdout } = runHook('claude', 'UserPromptSubmit', clean, {
      userPrompt: 'y',
      sessionId: b,
    });
    expect(stdout).toContain('stay in sync');
  });
});

describe('hook pre-tool-use (commit gate)', () => {
  // @lat: [[tests/hook#Commit gate denies once on staged code without lat.md]]
  it('denies a git commit once when staged code has no lat.md update, then yields', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[80, 30, 'src/big-refactor.ts']]));
    const sessionId = uniqueSessionId();
    try {
      const first = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId,
        toolName: 'Bash',
        toolCommand: 'git commit -F /tmp/msg.txt',
      });
      const parsed = JSON.parse(first.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('lat.md');

      const second = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId,
        toolName: 'Bash',
        toolCommand: 'git commit -F /tmp/msg.txt',
      });
      expect(second.stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Commit gate ignores non-commit commands]]
  it('stays silent for non-commit Bash commands', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[80, 30, 'src/big-refactor.ts']]));
    try {
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git log --oneline -5',
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Commit gate passes proportional staged lat.md]]
  it('stays silent when staged lat.md changes are proportional', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[60, 40, 'src/feature.ts'], [8, 2, 'lat.md/feature.md']]),
    );
    try {
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git commit -m x',
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('hook post-tool-use (work-start reminder)', () => {
  // @lat: [[tests/hook#Claim-time reminder fires once per session]]
  it('emits orientation on the first work-start tool call only', () => {
    const sessionId = uniqueSessionId();
    const first = runHook('claude', 'PostToolUse', clean, {
      sessionId,
      toolName: 'mcp__electronics__claim_item',
    });
    const parsed = JSON.parse(first.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('lat search');

    const second = runHook('claude', 'PostToolUse', clean, {
      sessionId,
      toolName: 'mcp__electronics__my_queue',
    });
    expect(second.stdout).toBe('');
  });
});

describe('hook stop', () => {
  // @lat: [[tests/hook#Exits silently when check passes and no diff]]
  it('exits silently when check passes and no diff', () => {
    const fakeBinDir = makeFakeGitDir('');
    try {
      const { stdout, stderr } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Blocks when lat check fails]]
  it('blocks when lat check fails', () => {
    const { stdout } = runStopHook('claude', broken);
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('lat check');
    expect(parsed.reason).toContain('error');
  });

  // @lat: [[tests/hook#Blocks when code diff is large but lat.md/ not updated]]
  it('blocks when code diff is large but lat.md/ not updated', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('110');
      expect(parsed.reason).toContain('lat.md/');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Session attribution suppresses another session's diff]]
  it('exits silently when the dirty code was not edited by this session', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      // This session only READ the dirty file and edited something outside
      // the counted diff — a bystander on a shared tree.
      const transcriptPath = makeTranscript(fakeBinDir, [
        { name: 'Read', file_path: 'C:\\repo\\src\\big-refactor.ts' },
        { name: 'Edit', file_path: 'C:\\elsewhere\\notes.md' },
      ]);
      const { stdout } = runStopHook('claude', clean, {
        fakeBinDir,
        transcriptPath,
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Session attribution still nags the session that edited]]
  it('blocks when this session edited the dirty code', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const transcriptPath = makeTranscript(fakeBinDir, [
        { name: 'Edit', file_path: 'C:\\repo\\src\\big-refactor.ts' },
      ]);
      const { stdout } = runStopHook('claude', clean, {
        fakeBinDir,
        transcriptPath,
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('lat.md/');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Unreadable transcript disables attribution]]
  it('blocks unfiltered when the transcript path cannot be read', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const { stdout } = runStopHook('claude', clean, {
        fakeBinDir,
        transcriptPath: join(fakeBinDir, 'no-such-transcript.jsonl'),
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Exits silently when lat.md/ changes are proportional]]
  it('exits silently when lat.md/ changes are proportional', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[60, 40, 'src/feature.ts'], [8, 2, 'lat.md/feature.md']]),
    );
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Exits silently when code diff is below threshold]]
  it('exits silently when code diff is below threshold', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[2, 1, 'src/tiny.ts']]));
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Blocks with both messages when check fails and diff needs sync]]
  it('blocks with both messages when check fails and diff needs sync', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[50, 60, 'src/refactor.ts']]));
    try {
      const { stdout } = runStopHook('claude', broken, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('Update `lat.md/`');
      expect(parsed.reason).toContain('lat check` until it passes');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Exits silently on second pass when check passes]]
  it('exits silently on second pass when check passes', () => {
    const { stdout, stderr } = runStopHook('claude', clean, {
      stopHookActive: true,
    });
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  // @lat: [[tests/hook#Prints stderr warning on second pass when check still fails]]
  it('prints stderr warning on second pass when check still fails', () => {
    const { stdout, stderr } = runStopHook('claude', broken, {
      stopHookActive: true,
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('still failing');
  });

  // @lat: [[tests/hook#Ignores non-code files in diff]]
  it('ignores non-code files in diff', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[150, 50, 'README.md']]));
    try {
      const { stdout } = runStopHook('claude', clean, { fakeBinDir });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Cursor stop hook returns follow-up work instead of a Claude block]]
  it('returns a Cursor follow-up message when stop needs more work', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
    try {
      const { stdout } = runStopHook('cursor', clean, { fakeBinDir });
      const parsed = JSON.parse(stdout);
      expect(parsed.followup_message).toContain('lat.md/');
      expect(parsed.followup_message).toContain('110');
      expect(parsed.decision).toBeUndefined();
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});
