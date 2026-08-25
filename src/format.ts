import { join, relative } from 'node:path';
import type { Section, SectionMatch } from './lattice.js';
import type { CmdContext, Styler } from './context.js';

export function formatSectionId(id: string, s: Styler): string {
  const parts = id.split('#');
  return parts.length === 1
    ? s.boldWhite(parts[0])
    : s.dim(parts.slice(0, -1).join('#') + '#') +
        s.boldWhite(parts[parts.length - 1]);
}

export function formatSectionPreview(
  ctx: CmdContext,
  section: Section,
  opts?: { reason?: string; sourceDate?: string | null },
): string {
  const s = ctx.styler;
  const relPath = relative(
    process.cwd(),
    join(ctx.projectRoot, section.filePath),
  );

  const kind = section.id.includes('#') ? 'Section' : 'File';
  const reasonSuffix = opts?.reason ? ' ' + s.dim(`(${opts.reason})`) : '';
  // Reference hits are tagged at the point of reading, not in a footnote — the
  // tag and the date together are what let a reader judge currency on contact.
  const tier = section.ref ? s.yellow('[ref] ') : '';
  const dated =
    section.ref && opts?.sourceDate
      ? s.dim(` · last change ${opts.sourceDate}`)
      : '';
  const lines: string[] = [
    `${s.dim('*')} ${tier}${s.dim(kind + ':')} [[${formatSectionId(section.id, s)}]]${reasonSuffix}`,
    `  ${s.dim('Defined in')} ${s.cyan(relPath)}${s.dim(`:${section.startLine}-${section.endLine}`)}${dated}`,
  ];

  if (section.firstParagraph) {
    lines.push('', `  ${s.dim('>')} ${section.firstParagraph}`);
  }

  return lines.join('\n');
}

export function formatResultList(
  ctx: CmdContext,
  header: string,
  matches: SectionMatch[],
): string {
  const lines: string[] = ['', `## ${header}`, ''];

  for (let i = 0; i < matches.length; i++) {
    if (i > 0) lines.push('');
    lines.push(
      formatSectionPreview(ctx, matches[i].section, {
        reason: matches[i].reason,
        sourceDate: matches[i].sourceDate,
      }),
    );
  }

  if (matches.some((m) => m.section.ref)) {
    lines.push('', refTierNote(ctx.styler));
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Shown whenever reference hits are present. Deliberately unflattering: the
 * reference tier is a search convenience, and a reader who cannot feel the
 * difference between it and `lat.md/` will eventually fold nothing and trust
 * everything.
 */
export function refTierNote(s: Styler): string {
  return (
    s.dim('Note: ') +
    s.yellow('[ref]') +
    s.dim(
      ' results are indexed reference docs, not graph-checked law — nothing' +
        ' verifies they still match the code. Check the date before trusting one.',
    )
  );
}

export function formatNavHints(ctx: CmdContext): string {
  const s = ctx.styler;
  const hints =
    ctx.mode === 'cli'
      ? `${s.dim('*')} \`lat section "section#id"\` \u2014 show full content with outgoing/incoming refs\n` +
        `${s.dim('*')} \`lat search "new query"\` \u2014 search for something else`
      : `${s.dim('*')} \`lat_section\` \u2014 show full content with outgoing/incoming refs\n` +
        `${s.dim('*')} \`lat_search\` \u2014 search for something else`;
  return `\n## To navigate further:\n\n${hints}`;
}
