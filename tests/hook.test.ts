import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
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
function makeFakeGitDir(
  output: string,
  extra: {
    nameonly?: string;
    subjects?: string;
    porcelain?: string;
    oneline?: string;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'lat-hook-'));
  // Arg-aware shim: each probe kind reads its own data file; kinds not
  // overridden fall back to the main output (the original arg-blind behavior).
  writeFileSync(join(dir, 'numstat.txt'), output);
  writeFileSync(join(dir, 'nameonly.txt'), extra.nameonly ?? output);
  writeFileSync(join(dir, 'subjects.txt'), extra.subjects ?? output);
  writeFileSync(join(dir, 'porcelain.txt'), extra.porcelain ?? output);
  writeFileSync(join(dir, 'oneline.txt'), extra.oneline ?? output);

  // POSIX: `git` shell script.
  const shScript = join(dir, 'git');
  writeFileSync(
    shScript,
    [
      '#!/bin/sh',
      'd="$(dirname "$0")"',
      'case "$*" in',
      '  *--numstat*) cat "$d/numstat.txt";;',
      '  *--name-only*) cat "$d/nameonly.txt";;',
      '  *--porcelain*) cat "$d/porcelain.txt";;',
      '  *--format=%s*) cat "$d/subjects.txt";;',
      '  *--oneline*) cat "$d/oneline.txt";;',
      '  *) cat "$d/numstat.txt";;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(shScript, 0o755);

  // Windows: `git.cmd` batch shim (resolved via PATHEXT). `type` preserves tabs.
  const cmdScript = join(dir, 'git.cmd');
  writeFileSync(
    cmdScript,
    [
      '@echo off',
      'echo %* | findstr /C:"--numstat" >nul 2>&1 && (type "%~dp0numstat.txt" & exit /b 0)',
      'echo %* | findstr /C:"--name-only" >nul 2>&1 && (type "%~dp0nameonly.txt" & exit /b 0)',
      'echo %* | findstr /C:"--porcelain" >nul 2>&1 && (type "%~dp0porcelain.txt" & exit /b 0)',
      'echo %* | findstr /C:"--format" >nul 2>&1 && (type "%~dp0subjects.txt" & exit /b 0)',
      'echo %* | findstr /C:"--oneline" >nul 2>&1 && (type "%~dp0oneline.txt" & exit /b 0)',
      'type "%~dp0numstat.txt"',
      '\r\n',
    ].join('\r\n'),
  );

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
        content: [
          { type: 'tool_use', name: c.name, input: { file_path: c.file_path } },
        ],
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
    toolInput?: Record<string, unknown>;
    source?: string;
    toolResponseText?: string;
    worktreePath?: string;
  } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const stdinJson = JSON.stringify({
    stop_hook_active: opts.stopHookActive ?? false,
    ...(opts.transcriptPath ? { transcript_path: opts.transcriptPath } : {}),
    ...(opts.userPrompt ? { user_prompt: opts.userPrompt } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(opts.toolName ? { tool_name: opts.toolName } : {}),
    ...(opts.toolCommand
      ? { tool_input: { command: opts.toolCommand } }
      : opts.toolInput
        ? { tool_input: opts.toolInput }
        : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.toolResponseText
      ? {
          tool_response: {
            content: [{ type: 'text', text: opts.toolResponseText }],
          },
        }
      : {}),
    ...(opts.worktreePath ? { worktree_path: opts.worktreePath } : {}),
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
const traps = join(casesDir, 'hook-traps');

function uniqueSessionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('hook prompt submit', () => {
  // @lat: [[tests/hook#Prompt hook is dynamic-only]]
  it('emits nothing when the prompt has no refs and no index matches', () => {
    const { stdout } = runHook('claude', 'UserPromptSubmit', clean, {
      userPrompt: 'do a thing',
      sessionId: uniqueSessionId(),
    });
    expect(stdout).toBe('');
  });
});

describe('hook session start', () => {
  // @lat: [[tests/hook#Session orientation fires once at start]]
  it('emits orientation on startup once per session', () => {
    const sessionId = uniqueSessionId();
    const first = runHook('claude', 'SessionStart', clean, {
      sessionId,
      source: 'startup',
    });
    expect(first.stdout).toContain('lat search');
    expect(first.stdout).toContain('lat check');

    const second = runHook('claude', 'SessionStart', clean, {
      sessionId,
      source: 'resume',
    });
    expect(second.stdout).toBe('');
  });

  // @lat: [[tests/hook#Compact re-anchor fires at most twice]]
  it('re-anchors discipline after compaction, at most twice', () => {
    const sessionId = uniqueSessionId();
    for (let i = 0; i < 2; i++) {
      const { stdout } = runHook('claude', 'SessionStart', clean, {
        sessionId,
        source: 'compact',
      });
      expect(stdout).toContain('re-anchor');
    }
    const third = runHook('claude', 'SessionStart', clean, {
      sessionId,
      source: 'compact',
    });
    expect(third.stdout).toBe('');
  });

  // @lat: [[tests/hook#Non-adopted repos get a silent no-op]]
  it('is silent in a directory with no lat.md anywhere above', () => {
    const noLat = mkdtempSync(join(tmpdir(), 'lat-nolat-'));
    try {
      const { stdout, stderr } = runHook('claude', 'SessionStart', noLat, {
        sessionId: uniqueSessionId(),
        source: 'startup',
      });
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    } finally {
      rmDirBestEffort(noLat);
    }
  });
});

describe('hook pre-tool-use (commit gate)', () => {
  // @lat: [[tests/hook#Commit gate denies once on staged code without lat.md]]
  it('denies a git commit once when staged code has no lat.md update, then yields', () => {
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
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
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
        'lat.md',
      );

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
    const fakeBinDir = makeFakeGitDir(
      numstat([[80, 30, 'src/big-refactor.ts']]),
    );
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
      numstat([
        [60, 40, 'src/feature.ts'],
        [8, 2, 'lat.md/feature.md'],
      ]),
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

describe('hook pre-tool-use (session fire ceiling)', () => {
  // @lat: [[tests/hook#Commit gate speaks at most twice per session]]
  it('denies at most twice per session across distinct staged states', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[80, 30, 'src/a.ts']]));
    const sessionId = uniqueSessionId();
    const commitOpts = {
      fakeBinDir,
      sessionId,
      toolName: 'Bash',
      toolCommand: 'git commit -m x',
    };
    try {
      const first = runHook('claude', 'PreToolUse', clean, commitOpts);
      expect(
        JSON.parse(first.stdout).hookSpecificOutput.permissionDecision,
      ).toBe('deny');

      writeFileSync(
        join(fakeBinDir, 'numstat.txt'),
        numstat([[90, 40, 'src/b.ts']]),
      );
      const second = runHook('claude', 'PreToolUse', clean, commitOpts);
      expect(
        JSON.parse(second.stdout).hookSpecificOutput.permissionDecision,
      ).toBe('deny');

      writeFileSync(
        join(fakeBinDir, 'numstat.txt'),
        numstat([[100, 50, 'src/c.ts']]),
      );
      const third = runHook('claude', 'PreToolUse', clean, commitOpts);
      expect(third.stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('hook pre-tool-use (push checks)', () => {
  // @lat: [[tests/hook#Push gate denies a stranded lat.md fold once]]
  it('denies a push once when lat.md/ has uncommitted changes, then informs, then quiets', () => {
    // The arg-blind fake git returns the same non-empty output for the
    // porcelain and log probes, exercising fold-deny then manifest paths.
    const fakeBinDir = makeFakeGitDir(numstat([[5, 1, 'lat.md/topic.md']]));
    const sessionId = uniqueSessionId();
    const pushOpts = {
      fakeBinDir,
      sessionId,
      toolName: 'Bash',
      toolCommand: 'GIT_SSH=ssh.exe git push',
    };
    try {
      const first = runHook('claude', 'PreToolUse', clean, pushOpts);
      const firstParsed = JSON.parse(first.stdout);
      expect(firstParsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(firstParsed.hookSpecificOutput.permissionDecisionReason).toContain(
        'lat.md',
      );

      const second = runHook('claude', 'PreToolUse', clean, pushOpts);
      const secondParsed = JSON.parse(second.stdout);
      expect(
        secondParsed.hookSpecificOutput.permissionDecision,
      ).toBeUndefined();
      expect(secondParsed.hookSpecificOutput.additionalContext).toContain(
        'About to push',
      );

      runHook('claude', 'PreToolUse', clean, pushOpts); // second manifest fire
      const fourth = runHook('claude', 'PreToolUse', clean, pushOpts);
      expect(fourth.stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Push fold check respects session attribution]]
  it("does not deny a push over another session's dirty lat.md", () => {
    const fakeBinDir = makeFakeGitDir(numstat([[5, 1, 'lat.md/topic.md']]));
    try {
      const transcriptPath = makeTranscript(fakeBinDir, [
        { name: 'Edit', file_path: 'C:\\repo\\src\\mine.ts' },
      ]);
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git push',
        transcriptPath,
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'About to push',
      );
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Push checks stay silent on a clean tree]]
  it('stays silent when nothing is stranded and nothing is unpushed', () => {
    const fakeBinDir = makeFakeGitDir('');
    try {
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git push',
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('hook post-tool-use-failure (trap table)', () => {
  // @lat: [[tests/hook#Trap table injects the known fix once]]
  it('injects the known fix on a matching failure, once per session', () => {
    const sessionId = uniqueSessionId();
    const first = runHook('claude', 'PostToolUseFailure', traps, {
      sessionId,
      toolName: 'Bash',
      toolCommand: 'uv run pytest tests -q',
      toolResponseText: 'error: Failed to spawn: pytest',
    });
    const parsed = JSON.parse(first.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'uv sync --extra dev',
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'uv-extras-uninstalled',
    );

    const second = runHook('claude', 'PostToolUseFailure', traps, {
      sessionId,
      toolName: 'Bash',
      toolCommand: 'uv run pytest tests -q',
      toolResponseText: 'error: Failed to spawn: pytest',
    });
    expect(second.stdout).toBe('');
  });

  // @lat: [[tests/hook#Trap table stays silent without a match]]
  it('stays silent for failures matching no trap (bad-regex entries skipped)', () => {
    const { stdout } = runHook('claude', 'PostToolUseFailure', traps, {
      sessionId: uniqueSessionId(),
      toolName: 'Bash',
      toolCommand: 'ls',
      toolResponseText: 'No such file or directory',
    });
    expect(stdout).toBe('');
  });
});

describe('hook pre-tool-use (docker stale-test guard)', () => {
  // @lat: [[tests/hook#Docker guard denies a bare test run once]]
  it('denies a bare run --rm test once, passes identical retry and build+test', () => {
    const sessionId = uniqueSessionId();
    const bare = {
      sessionId,
      toolName: 'Bash',
      toolCommand: 'docker compose run --rm test',
    };
    const first = runHook('claude', 'PreToolUse', clean, bare);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'COPY layer',
    );

    const retry = runHook('claude', 'PreToolUse', clean, bare);
    expect(retry.stdout).toBe('');

    const full = runHook('claude', 'PreToolUse', clean, {
      sessionId,
      toolName: 'Bash',
      toolCommand: 'docker compose build && docker compose run --rm test',
    });
    expect(full.stdout).toBe('');
  });
});

describe('hook pre-tool-use (two-lab push reminder)', () => {
  // @lat: [[tests/hook#Two-lab reminder rides the push manifest]]
  it('adds the two-lab line when outgoing src/ commits carry no fold', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[10, 2, 'src/x.ts']]), {
      porcelain: '',
      nameonly: 'src/x.ts\n',
      subjects: 'TK-1: fix the thing\n',
      oneline: 'abc1234 TK-1: fix the thing\n',
    });
    try {
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git push',
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'About to push',
      );
      expect(parsed.hookSpecificOutput.additionalContext).toContain('two-lab');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });

  // @lat: [[tests/hook#Two-lab reminder respects an existing fold commit]]
  it('omits the two-lab line when the stack already has a fold commit', () => {
    const fakeBinDir = makeFakeGitDir(numstat([[10, 2, 'src/x.ts']]), {
      porcelain: '',
      nameonly: 'src/x.ts\n',
      subjects: 'two-lab fold r1: things\nTK-1: fix\n',
      oneline: 'abc1234 two-lab fold r1: things\n',
    });
    try {
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git push',
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'About to push',
      );
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain(
        'two-lab fold:` commit',
      );
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('hook global advisory budget', () => {
  // @lat: [[tests/hook#Advisory pool bounds total pokes]]
  it('silences advisory surfaces once the session pool is spent; corrective still speaks', () => {
    const sessionId = uniqueSessionId();
    const fakeBinDir = makeFakeGitDir('', {
      oneline: 'abc1234 TK-1: fix\n',
      porcelain: '',
      nameonly: 'docs/readme.md\n',
      subjects: 'TK-1: fix\n',
    });
    try {
      // Spend the pool: orient(1) + work-start(1) + claim×2 + manifest×2 = 6.
      runHook('claude', 'SessionStart', clean, {
        sessionId,
        source: 'startup',
      });
      runHook('claude', 'PostToolUse', clean, {
        sessionId,
        toolName: 'mcp__electronics__my_queue',
      });
      for (let i = 0; i < 2; i++) {
        runHook('claude', 'PostToolUse', clean, {
          sessionId,
          toolName: 'mcp__electronics__claim_item',
          toolResponseText: '{"summary":"item"}',
        });
      }
      for (let i = 0; i < 2; i++) {
        runHook('claude', 'PreToolUse', clean, {
          fakeBinDir,
          sessionId,
          toolName: 'Bash',
          toolCommand: 'git push',
        });
      }

      // Pool spent: a compact re-anchor (advisory, own surface unused) is silent.
      const advisory = runHook('claude', 'SessionStart', clean, {
        sessionId,
        source: 'compact',
      });
      expect(advisory.stdout).toBe('');

      // Corrective still speaks: docker guard denies regardless of the pool.
      const corrective = runHook('claude', 'PreToolUse', clean, {
        sessionId,
        toolName: 'Bash',
        toolCommand: 'docker compose run --rm test',
      });
      expect(
        JSON.parse(corrective.stdout).hookSpecificOutput.permissionDecision,
      ).toBe('deny');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('hook worktree create', () => {
  // @lat: [[tests/hook#Worktree inherits the untracked settings]]
  it('copies .claude/settings.json into the new worktree', () => {
    const wt = mkdtempSync(join(tmpdir(), 'lat-wt-'));
    try {
      const { exitCode } = runHook('claude', 'WorktreeCreate', clean, {
        sessionId: uniqueSessionId(),
        worktreePath: wt,
      });
      expect(exitCode).toBe(0);
      expect(existsSync(join(wt, '.claude', 'settings.json'))).toBe(true);
    } finally {
      rmDirBestEffort(wt);
    }
  });
});

describe('hook post-tool-use (work-start reminder)', () => {
  // @lat: [[tests/hook#Claim-time reminder fires once per session]]
  it('emits orientation on the first work-start tool call only', () => {
    const sessionId = uniqueSessionId();
    const first = runHook('claude', 'PostToolUse', clean, {
      sessionId,
      toolName: 'mcp__electronics__my_queue',
    });
    const parsed = JSON.parse(first.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('lat search');

    const second = runHook('claude', 'PostToolUse', clean, {
      sessionId,
      toolName: 'mcp__electronics__view_item',
    });
    expect(second.stdout).toBe('');
  });

  // @lat: [[tests/hook#Claim auto-search falls back to the reminder]]
  it('claim with a response but no index falls back to the static reminder, then quiets', () => {
    const sessionId = uniqueSessionId();
    const first = runHook('claude', 'PostToolUse', clean, {
      sessionId,
      toolName: 'mcp__electronics__claim_item',
      toolResponseText: '{"id":"PA-1","summary":"fix the widget lifecycle"}',
    });
    const parsed = JSON.parse(first.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('lat search');

    const second = runHook('claude', 'PostToolUse', clean, {
      sessionId,
      toolName: 'mcp__electronics__claim_item',
      toolResponseText: '{"id":"PA-2","summary":"another item"}',
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
      numstat([
        [60, 40, 'src/feature.ts'],
        [8, 2, 'lat.md/feature.md'],
      ]),
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

const wrapup = join(casesDir, 'hook-wrapup');

describe('hook codex', () => {
  // @lat: [[tests/hook#Codex shares the Claude hook contract]]
  it('emits the Claude payload shape on a shared event', () => {
    const { stdout } = runHook('codex', 'SessionStart', clean, {
      sessionId: uniqueSessionId(),
      source: 'startup',
    });
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe('SessionStart');
    expect(out.additionalContext).toContain('lat search');
  });

  // @lat: [[tests/hook#Codex rejects the Claude-only surfaces]]
  it('exits non-zero on a Claude-only event', () => {
    const { exitCode, stderr } = runHook('codex', 'WorktreeCreate', clean, {
      sessionId: uniqueSessionId(),
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown hook event for codex');
  });
});

describe('hook pre-tool-use (stash is not a push)', () => {
  // @lat: [[tests/hook#Stash is not treated as a remote push]]
  it('does not run push checks on a git stash push', () => {
    const fakeBinDir = makeFakeGitDir('', {
      porcelain: ' M lat.md/feature.md\n',
      oneline: 'abc1234 TK-1: fix\n',
    });
    try {
      const { stdout } = runHook('claude', 'PreToolUse', clean, {
        fakeBinDir,
        sessionId: uniqueSessionId(),
        toolName: 'Bash',
        toolCommand: 'git stash push -- src/',
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(fakeBinDir);
    }
  });
});

describe('hook pre-tool-use (wrap-up gate)', () => {
  /**
   * Transcript for a session that edited the fixture's source file, optionally
   * also folding the `lat.md/` file that documents it.
   */
  function wrapupTranscript(dir: string, folded: boolean): string {
    const calls = [
      { name: 'Edit', file_path: join(wrapup, 'src', 'widget.ts') },
    ];
    if (folded) {
      calls.push({
        name: 'Edit',
        file_path: join(wrapup, 'lat.md', 'widget.md'),
      });
    }
    return makeTranscript(dir, calls);
  }

  // @lat: [[tests/hook#Wrap-up gate denies a ship transition with unfolded sections]]
  it('denies a ship transition and names the unfolded section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-wrapup-'));
    try {
      const { stdout } = runHook('claude', 'PreToolUse', wrapup, {
        sessionId: uniqueSessionId(),
        toolName: 'mcp__electronics__update_status',
        toolInput: { id: 'PA-1', new_status: 'applied' },
        transcriptPath: wrapupTranscript(dir, false),
      });
      const out = JSON.parse(stdout).hookSpecificOutput;
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toContain(
        'lat.md/widget#Widget#Rendering',
      );
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Wrap-up gate stays silent when the documenting section was touched]]
  it('stays silent once the documenting section was folded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-wrapup-'));
    try {
      const { stdout } = runHook('claude', 'PreToolUse', wrapup, {
        sessionId: uniqueSessionId(),
        toolName: 'mcp__electronics__update_status',
        toolInput: { id: 'PA-1', new_status: 'applied' },
        transcriptPath: wrapupTranscript(dir, true),
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Wrap-up gate ignores mid-work status values]]
  it('ignores a non-terminal status transition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-wrapup-'));
    try {
      const { stdout } = runHook('claude', 'PreToolUse', wrapup, {
        sessionId: uniqueSessionId(),
        toolName: 'mcp__electronics__update_status',
        toolInput: { id: 'TK-1', new_status: 'in-progress' },
        transcriptPath: wrapupTranscript(dir, false),
      });
      expect(stdout).toBe('');
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Wrap-up gate yields on a retried debt set]]
  it('yields on an identical debt set retried', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-wrapup-'));
    try {
      const sessionId = uniqueSessionId();
      const transcriptPath = wrapupTranscript(dir, false);
      const opts = {
        sessionId,
        toolName: 'mcp__electronics__complete_plan',
        toolInput: { id: 'IP-1' },
        transcriptPath,
      };
      const first = runHook('claude', 'PreToolUse', wrapup, opts);
      expect(
        JSON.parse(first.stdout).hookSpecificOutput.permissionDecision,
      ).toBe('deny');

      const second = runHook('claude', 'PreToolUse', wrapup, opts);
      expect(second.stdout).toBe('');
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Archive injects the residual reminder without blocking]]
  it('archives with advisory context and no permission decision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-wrapup-'));
    try {
      const { stdout } = runHook('claude', 'PreToolUse', wrapup, {
        sessionId: uniqueSessionId(),
        toolName: 'mcp__electronics__archive_item',
        toolInput: { id: 'TK-1', outcome: 'fixed' },
        transcriptPath: wrapupTranscript(dir, true),
      });
      const out = JSON.parse(stdout).hookSpecificOutput;
      expect(out.permissionDecision).toBeUndefined();
      expect(out.additionalContext).toContain('known limitation');
    } finally {
      rmDirBestEffort(dir);
    }
  });

  // @lat: [[tests/hook#Wrap-up matching ignores the MCP server name]]
  it('fires on any surface exposing the tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lat-wrapup-'));
    try {
      const { stdout } = runHook('claude', 'PreToolUse', wrapup, {
        sessionId: uniqueSessionId(),
        // Underscored server name: the prefix strip must not eat the tool name.
        toolName: 'mcp__minimart_toys__update_status',
        toolInput: { id: 'TK-9', new_status: 'patched' },
        transcriptPath: wrapupTranscript(dir, false),
      });
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe(
        'deny',
      );
    } finally {
      rmDirBestEffort(dir);
    }
  });
});

describe('hook user-prompt-submit (search opt-in)', () => {
  // @lat: [[tests/hook#Prompt search stays off without the opt-in]]
  it('resolves [[refs]] but runs no speculative search by default', () => {
    // The ref path still fires — it answers something the user explicitly typed.
    const withRef = runHook('claude', 'UserPromptSubmit', wrapup, {
      sessionId: uniqueSessionId(),
      userPrompt: 'check [[Rendering]] before editing',
    });
    expect(
      JSON.parse(withRef.stdout).hookSpecificOutput.additionalContext,
    ).toContain('Expanded user prompt');

    // A plain prompt emits nothing: no search is attempted without the flag.
    const plain = runHook('claude', 'UserPromptSubmit', wrapup, {
      sessionId: uniqueSessionId(),
      userPrompt: 'how does the widget renderer work',
    });
    expect(plain.stdout).toBe('');
  });
});
