import { execFileSync } from 'node:child_process';

/**
 * Date (YYYY-MM-DD) of the last commit that touched `file`, or null when the
 * file is untracked, the tree isn't a git repo, or git isn't on PATH.
 *
 * Used to stamp indexed reference sources (see [[lattice#Reference Sources]]).
 * A reference doc is admitted to the index by its author's marker, but that
 * marker is a one-shot act — it does not decay as the doc goes stale. The
 * commit date is the decay signal: a reader comparing it against the lat.md
 * sections it overlaps can judge currency without any additional gate.
 */
export function lastCommitDate(cwd: string, file: string): string | null {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%ad', '--date=short', '--', file],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}
