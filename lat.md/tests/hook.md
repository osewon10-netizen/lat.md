---
lat:
  require-code-mention: true
---
# Hook

Functional tests for the Stop hook. Runs `lat hook claude Stop` as a subprocess against test case fixtures, with a fake `git` script injected via PATH to control `git diff HEAD --numstat` output.

Tests in `tests/hook.test.ts`.

## Exits silently when check passes and no diff

When `lat check` passes and there is no git diff output, the hook produces no stdout and no stderr — the agent stops cleanly.

## Blocks when lat check fails

When `lat check` finds errors, the hook outputs a block decision with a reason mentioning `lat check` and the error count.

## Blocks when code diff is large but lat.md/ not updated

When check passes but `git diff --numstat` shows code changes above the threshold with no `lat.md/` changes, the hook blocks with a reminder to update `lat.md/`.

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

## Blocks with both messages when check fails and diff needs sync

When `lat check` fails and the diff also needs sync, the block reason includes both "update `lat.md/`" and "run `lat check` until it passes".

## Exits silently on second pass when check passes

On the second pass (`stop_hook_active: true`), if `lat check` passes, the hook exits silently with no output.

## Prints stderr warning on second pass when check still fails

On the second pass, if `lat check` still fails, the hook prints a warning to stderr but does not block — the loop stops.

## Ignores non-code files in diff

Files that don't match `SOURCE_EXTENSIONS` (e.g. `.md`) are not counted toward code lines, so a large markdown-only diff does not trigger a sync reminder.

## Cursor stop hook returns follow-up work instead of a Claude block

When Cursor needs more work at stop time, the hook returns a `followup_message` payload instead of Claude's `decision: "block"` shape so the agent keeps going in Cursor's native hook format.
