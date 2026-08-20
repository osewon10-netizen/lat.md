---
lat:
  require-code-mention: true
---
# Hook

Functional tests for the Stop and UserPromptSubmit hooks. Runs `lat hook claude <event>` as a subprocess against test case fixtures, with a fake `git` script injected via PATH to control `git diff HEAD --numstat` output.

Tests in `tests/hook.test.ts`.

## Prompt hook is dynamic-only

With no `[[refs]]` in the prompt and no index matches, UserPromptSubmit emits
nothing — the static orientation lives in SessionStart, so prompts carry only
per-prompt content.

## Session orientation fires once at start

SessionStart with a non-compact source emits the orientation reminder once
per session; a later resume in the same session is silent.

## Compact re-anchor fires at most twice

SessionStart with `source: compact` emits the discipline re-anchor, capped at
two firings per session.

## Non-adopted repos get a silent no-op

SessionStart in a directory with no `lat.md/` anywhere above produces no
output on stdout or stderr — repos that haven't adopted lat.md need no
carve-outs.

## Claim auto-search falls back to the reminder

A claim_item response with no usable search index falls back to the static
work-start reminder; once budgets are spent, further claims are silent. (The
search-injection path itself needs a live index and is verified live, not in
fixtures.)

## Exits silently on a clean tree

With no git diff output the hook produces no stdout and no stderr — the agent stops cleanly.

## Does not block on a broken graph

Broken wiki links do not block a turn end.

Graph validity is already enforced twice: the test suite runs `lat check` against the repo's own graph, and CI runs it on every push and pull request. A third gate at turn end blocked on errors it never attributed to the session that caused them.

## Blocks when code diff is large but lat.md/ not updated

When check passes but `git diff --numstat` shows code changes above the threshold with no `lat.md/` changes, the hook blocks with a reminder to update `lat.md/`.

## Commit gate denies once on staged code without lat.md

A `git commit` Bash command with staged code above threshold and no staged
`lat.md/` update is denied with the fold reminder; the identical retry in the
same session and staged state passes — one nudge per staged state, never a
hard wall.

## Commit gate ignores non-commit commands

Bash commands without a git-commit segment (e.g. `git log`) produce no output
from the PreToolUse handler.

## Commit gate passes proportional staged lat.md

Staged `lat.md/` changes above the ratio let the commit proceed silently.

## Commit gate speaks at most twice per session

Across DISTINCT staged states, the commit gate denies at most twice per
session (the global fire ceiling) — a third distinct state passes silently.

## Push gate denies a stranded lat.md fold once

A push with uncommitted `lat.md/` changes is denied once with the
fold-lands-before-the-push reminder; the retry gets the unpushed-commit
manifest as advisory context, and after the budget, silence.

## Push fold check respects session attribution

Dirty `lat.md/` files this session never edited (another session's in-flight
fold on a shared tree) do not trigger the stranded-fold deny; the manifest
still arrives as advisory context.

## Push checks stay silent on a clean tree

With nothing stranded and nothing unpushed, a push produces no hook output.

## Trap table injects the known fix once

A failure whose text matches a `traps.md` signature gets the entry's fix
injected as context; the same trap in the same session is silent afterwards.

## Trap table stays silent without a match

Failures matching no signature produce no output, and a trap entry with an
invalid regex is skipped rather than fatal.

## Docker guard denies a bare test run once

`docker compose run --rm test` without `build` in the chain (in a repo with a
docker-compose.yml) is denied once with the stale-COPY-layer reason; an
identical retry and a proper `build && test` chain both pass.

## Two-lab reminder rides the push manifest

An outgoing stack touching `src/` with no `two-lab fold:` commit subject gets
one advisory line appended to the push manifest — one message, two surfaces.

## Two-lab reminder respects an existing fold commit

A stack already carrying a `two-lab fold:` commit gets the manifest only.

## Advisory pool bounds total pokes

Once a session's shared advisory pool is spent across surfaces, further
advisory output is silent; corrective output (deny gates, trap fixes) still
speaks.

## Worktree inherits the untracked settings

WorktreeCreate copies the repo's `.claude/settings.json` into the new
worktree and always exits 0.

## Claim-time reminder fires once per session

The PostToolUse handler emits the lat orientation context on the first
work-start tool call of a session (queue read / item claim) and stays silent
on subsequent ones.

## Session attribution suppresses another session's diff

With a `transcript_path` on stdin, only files this session edited count toward
the sync tally — a bystander on a shared working tree exits silently.

Edited means write-tool calls in the transcript (Edit, Write, MultiEdit,
NotebookEdit); a session that merely read a dirty file, or edited files
outside the counted diff, is not nagged for another session's diff.

## Session attribution still nags the session that edited

With a transcript whose Edit call matches a dirty source file (absolute
transcript path matched by suffix against the repo-relative numstat path,
case-insensitive, both slash styles), the hook still blocks — the sync debt
follows authorship.

## Unreadable transcript disables attribution

When `transcript_path` is missing or unreadable, attribution is disabled and
the hook falls back to the unfiltered tally, preserving the pre-attribution
behavior for callers that pass no transcript.

## Exits silently when lat.md/ changes are proportional

When code changes are large but `lat.md/` changes exceed the 5% ratio, the hook exits silently.

## Exits silently when code diff is below threshold

When code changes are below 5 lines, the ratio check is skipped and the hook exits silently.

## Sync debt blocks without citing lat check

With both a broken graph and sync debt, the block reason covers only the debt — the hook no longer runs `lat check` or mentions it.

## Yields on the second pass

Having blocked once this stop cycle (`stop_hook_active: true`), the hook returns
before doing any work at all — even a diff that would otherwise nag produces
nothing.

## Ignores non-code files in diff

Files that don't match `SOURCE_EXTENSIONS` (e.g. `.md`) are not counted toward code lines, so a large markdown-only diff does not trigger a sync reminder.

## Cursor stop hook returns follow-up work instead of a Claude block

When Cursor needs more work at stop time, the hook returns a `followup_message` payload instead of Claude's `decision: "block"` shape so the agent keeps going in Cursor's native hook format.

## Wrap-up gate denies a ship transition with unfolded sections

`update_status` to `patched` denies once when the session edited a source file
whose documenting `lat.md/` section was never opened, naming that section in the
reason so the agent knows exactly what to fold.

## Wrap-up gate stays silent when the documenting section was touched

The same transition passes without output once the session also wrote the
`lat.md/` file holding the section that documents the changed source — the debt,
not the transition, is what the gate reacts to.

## Wrap-up gate ignores mid-work status values

`update_status` to a non-terminal status is ordinary mid-work traffic and never
reaches the debt check, so it produces no output regardless of fold state.

## Wrap-up gate yields on a retried debt set

Re-issuing the same transition against an unchanged debt set passes silently —
one nudge per debt set, never a wall in front of closing an item.

## Archive injects the residual reminder without blocking

`archive_item` emits advisory context about recording residuals and known
limitations, and carries no `permissionDecision` — denying a close would strand
the item on the verifying node.

## Wrap-up matching ignores the MCP server name

A wrap-up tool is recognized by its bare name with any `mcp__<server>__` prefix
stripped, so the same gate fires on whichever surface exposes the tool.

## Prompt search stays off without the opt-in

UserPromptSubmit runs no semantic search by default — a prompt with no `[[refs]]`
emits nothing even when an index would have matched.

## Stash is not treated as a remote push

A `git stash push` segment reaches no remote, so the push checks do not fire on
it — the word alone is not the signal.

## Codex shares the Claude hook contract

`lat hook codex SessionStart` emits the same `hookSpecificOutput` payload as the
Claude surface, since Codex implements that contract verbatim.

## Codex rejects the Claude-only surfaces

`WorktreeCreate` and `PostToolUseFailure` are not events Codex delivers, so
asking for them exits non-zero instead of silently doing nothing.
