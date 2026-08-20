---
lat:
  require-code-mention: true
---
# Expand

Tests for the `lat expand` command that resolves `[[refs]]` and appends context blocks.

The harness shells out to the built CLI, so the script path MUST be quoted — a
repo checked out under a path containing spaces otherwise splits the command and
hands node a truncated path, failing every case here for a reason that looks
like a CLI bug rather than a harness one.

## Resolves exact ref with context

When the input contains a `[[ref]]` that exactly matches a section, the output replaces it with the resolved id inline and appends a `<lat-context>` block with `is referring to:` phrasing and the section's location and body.

## Resolves fuzzy ref with alternatives

When the input contains a `[[ref]]` that matches via fuzzy/subsection/stem, the `<lat-context>` block uses `might be referring to either of the following:` phrasing and lists all candidates with match reasons.

## Passes through text without refs

When the input contains no `[[refs]]`, the output is the input verbatim with no context block appended.
