import { readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import {
  loadAllSections,
  loadRefSections,
  findSections,
  flattenSections,
  extractRefs,
  buildFileIndex,
  resolveRef,
  listLatticeFiles,
  type Section,
  type SectionMatch,
} from '../lattice.js';
import { lastCommitDate } from '../git.js';
import { scanCodeRefs, type ScanSkip } from '../code-refs.js';
import { SOURCE_EXTENSIONS, resolveSourceSymbol } from '../source-parser.js';
import type { CmdContext, CmdResult } from '../context.js';
import { formatSectionId, formatNavHints, refTierNote } from '../format.js';

export type CodeBackRef = {
  file: string;
  line: number;
  snippet: string;
};

export type SourceRef = {
  target: string;
  file: string;
  line: number;
  endLine: number;
  snippet: string;
};

export type SectionFound = {
  kind: 'found';
  section: Section;
  content: string;
  outgoingRefs: { target: string; resolved: Section }[];
  outgoingSourceRefs: SourceRef[];
  incomingRefs: SectionMatch[];
  codeRefs: CodeBackRef[];
  /** Set when the tree was never scanned, so an empty `codeRefs` means "not
   *  looked for" rather than "nothing points here". */
  codeScanSkipped?: ScanSkip;
  /** The section came from a reference source, not the lattice. */
  isRef?: boolean;
  /** Last content change of that reference source, when known. */
  sourceDate?: string | null;
};

export type SectionResult =
  | SectionFound
  | { kind: 'no-match'; suggestions: SectionMatch[] };

/**
 * Look up a section by id, return its content, outgoing wiki link targets,
 * and incoming references from other sections.
 */
export async function getSection(
  ctx: CmdContext,
  query: string,
): Promise<SectionResult> {
  query = query.replace(/^\[\[|\]\]$/g, '');

  const allSections = await loadAllSections(ctx.latDir);
  const matches = findSections(allSections, query);

  const confident = (m: SectionMatch[]): boolean =>
    m.length > 0 &&
    (m[0].reason === 'exact match' ||
      m[0].reason.startsWith('file stem expanded') ||
      m[0].reason === 'section name match');

  // Reference sources are searchable, so `lat section` has to be able to open
  // one — but only after the lattice has had its say, so law always wins a
  // name collision. Everything below this point is graph traversal that a
  // reference section is exempt from by definition, hence the early return.
  if (!confident(matches)) {
    const refMatches = findSections(
      await loadRefSections(ctx.projectRoot),
      query,
    );
    if (confident(refMatches)) return refSection(ctx, refMatches[0].section);
    if (matches.length === 0) {
      return { kind: 'no-match', suggestions: refMatches };
    }
    return { kind: 'no-match', suggestions: [...matches, ...refMatches] };
  }

  const section = matches[0].section;

  // Read raw content between startLine and the end of the last descendant
  const absPath = join(ctx.projectRoot, section.filePath);
  const fileContent = await readFile(absPath, 'utf-8');
  const lines = fileContent.split('\n');
  const end = fullEndLine(section);
  const content = lines.slice(section.startLine - 1, end).join('\n');

  // Find outgoing wiki link targets within this section's content
  const flat = flattenSections(allSections);
  const sectionIds = new Set(flat.map((s) => s.id.toLowerCase()));
  const fileIndex = buildFileIndex(allSections);
  const sectionRefs = extractRefs(absPath, fileContent, ctx.projectRoot);
  const sectionId = section.id.toLowerCase();

  const outgoingRefs: { target: string; resolved: Section }[] = [];
  const outgoingSourceRefs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of sectionRefs) {
    if (ref.fromSection.toLowerCase() !== sectionId) continue;
    // Detect source code references by file extension
    const hashIdx = ref.target.indexOf('#');
    const filePart = hashIdx === -1 ? ref.target : ref.target.slice(0, hashIdx);
    const ext = extname(filePart);
    if (SOURCE_EXTENSIONS.has(ext)) {
      const targetLower = ref.target.toLowerCase();
      if (!seen.has(targetLower)) {
        seen.add(targetLower);
        const symbolPart = hashIdx === -1 ? '' : ref.target.slice(hashIdx + 1);
        let line = 0;
        let endLine = 0;
        let snippet = '';
        if (symbolPart) {
          const { found, symbols } = await resolveSourceSymbol(
            filePart,
            symbolPart,
            ctx.projectRoot,
          );
          if (found) {
            const parts = symbolPart.split('#');
            const sym = symbols.find((s) =>
              parts.length === 1
                ? s.name === parts[0] && !s.parent
                : s.name === parts[1] && s.parent === parts[0],
            );
            if (sym) {
              line = sym.startLine;
              endLine = sym.endLine;
              try {
                const src = await readFile(
                  join(ctx.projectRoot, filePart),
                  'utf-8',
                );
                const srcLines = src.split('\n');
                const start = sym.startLine - 1;
                const end = Math.min(srcLines.length, start + 5);
                snippet = srcLines.slice(start, end).join('\n');
              } catch {
                // file unreadable
              }
            }
          }
        }
        outgoingSourceRefs.push({
          target: ref.target,
          file: filePart,
          line,
          endLine,
          snippet,
        });
      }
      continue;
    }
    const { resolved } = resolveRef(ref.target, sectionIds, fileIndex);
    const resolvedLower = resolved.toLowerCase();
    if (seen.has(resolvedLower)) continue;
    seen.add(resolvedLower);
    const targetSection = flat.find(
      (s) => s.id.toLowerCase() === resolvedLower,
    );
    if (targetSection) {
      outgoingRefs.push({ target: ref.target, resolved: targetSection });
    }
  }

  // Find incoming references: other sections that link to this one
  const incomingRefs: SectionMatch[] = [];
  const files = await listLatticeFiles(ctx.latDir);
  const incomingSections = new Set<string>();

  for (const file of files) {
    const fc = await readFile(file, 'utf-8');
    const fileRefs = extractRefs(file, fc, ctx.projectRoot);
    for (const ref of fileRefs) {
      const { resolved } = resolveRef(ref.target, sectionIds, fileIndex);
      if (
        resolved.toLowerCase() === sectionId &&
        ref.fromSection.toLowerCase() !== sectionId
      ) {
        if (!incomingSections.has(ref.fromSection.toLowerCase())) {
          incomingSections.add(ref.fromSection.toLowerCase());
          const fromSection = flat.find(
            (s) => s.id.toLowerCase() === ref.fromSection.toLowerCase(),
          );
          if (fromSection) {
            incomingRefs.push({ section: fromSection, reason: 'wiki link' });
          }
        }
      }
    }
  }

  // Find code back-references: @lat: comments pointing to this section
  const codeRefs: CodeBackRef[] = [];
  const { refs: scannedRefs, skipped: codeScanSkipped } = await scanCodeRefs(
    ctx.projectRoot,
  );
  for (const ref of scannedRefs) {
    const { resolved: codeResolved } = resolveRef(
      ref.target,
      sectionIds,
      fileIndex,
    );
    if (codeResolved.toLowerCase() === sectionId) {
      const absFile = join(ctx.projectRoot, ref.file);
      let snippet = '';
      try {
        const src = await readFile(absFile, 'utf-8');
        const srcLines = src.split('\n');
        const start = Math.max(0, ref.line - 1 - 2);
        const end = Math.min(srcLines.length, ref.line - 1 + 3);
        snippet = srcLines.slice(start, end).join('\n');
      } catch {
        // file unreadable — skip snippet
      }
      codeRefs.push({ file: ref.file, line: ref.line, snippet });
    }
  }

  return {
    kind: 'found',
    section,
    content,
    outgoingRefs,
    outgoingSourceRefs,
    incomingRefs,
    codeRefs,
    codeScanSkipped,
  };
}

/**
 * Open a reference section: content only. No outgoing refs, no incoming refs,
 * no code back-references — a reference source is not in the graph, so every
 * one of those would be structurally empty and read as "nothing points here"
 * rather than "this was never part of the graph".
 */
async function refSection(
  ctx: CmdContext,
  section: Section,
): Promise<SectionFound> {
  const absPath = join(ctx.projectRoot, section.filePath);
  const lines = (await readFile(absPath, 'utf-8')).split('\n');
  return {
    kind: 'found',
    section,
    content: lines
      .slice(section.startLine - 1, fullEndLine(section))
      .join('\n'),
    outgoingRefs: [],
    outgoingSourceRefs: [],
    incomingRefs: [],
    codeRefs: [],
    isRef: true,
    sourceDate: lastCommitDate(ctx.projectRoot, section.filePath),
  };
}

function fullEndLine(section: Section): number {
  if (section.children.length === 0) return section.endLine;
  return fullEndLine(section.children[section.children.length - 1]);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Format a successful section result with styling.
 */
export function formatSectionOutput(
  ctx: CmdContext,
  result: SectionFound,
): string {
  const s = ctx.styler;
  const {
    section,
    content,
    outgoingRefs,
    outgoingSourceRefs,
    incomingRefs,
    codeRefs,
    codeScanSkipped,
  } = result;
  const relPath = relative(
    process.cwd(),
    join(ctx.projectRoot, section.filePath),
  );
  const loc = `${s.cyan(relPath)}${s.dim(`:${section.startLine}-${section.endLine}`)}`;

  const quoted = content
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

  const tier = result.isRef ? s.yellow('[ref] ') : '';
  const dated =
    result.isRef && result.sourceDate
      ? s.dim(` · last change ${result.sourceDate}`)
      : '';
  const parts: string[] = [
    `${tier}${s.bold('[[' + formatSectionId(section.id, s) + ']]')} (${loc})${dated}`,
    '',
    quoted,
  ];

  if (result.isRef) {
    parts.push('', refTierNote(s));
  }

  if (outgoingRefs.length > 0 || outgoingSourceRefs.length > 0) {
    parts.push('', '## This section references:', '');
    for (const ref of outgoingRefs) {
      const body = ref.resolved.firstParagraph
        ? ` ${s.dim('—')} ${truncate(ref.resolved.firstParagraph, 120)}`
        : '';
      parts.push(
        `${s.dim('*')} [[${formatSectionId(ref.resolved.id, s)}]]${body}`,
      );
    }
    for (const ref of outgoingSourceRefs) {
      const loc = ref.line
        ? ref.endLine && ref.endLine !== ref.line
          ? `${s.dim(` (${ref.file}:${ref.line}-${ref.endLine})`)}`
          : `${s.dim(` (${ref.file}:${ref.line})`)}`
        : `${s.dim(` (${ref.file})`)}`;
      parts.push(`${s.dim('*')} [[${s.cyan(ref.target)}]]${loc}`);
      if (ref.snippet) {
        const snippetLines = ref.snippet.split('\n');
        for (const line of snippetLines) {
          parts.push(`  ${s.dim('|')} ${line}`);
        }
      }
    }
  }

  if (incomingRefs.length > 0) {
    parts.push('', '## Referenced by:', '');
    for (const ref of incomingRefs) {
      const body = ref.section.firstParagraph
        ? ` ${s.dim('—')} ${truncate(ref.section.firstParagraph, 120)}`
        : '';
      parts.push(
        `${s.dim('*')} [[${formatSectionId(ref.section.id, s)}]]${body}`,
      );
    }
  }

  if (codeScanSkipped) {
    parts.push(
      '',
      s.yellow('Note:') +
        ` code back-references not scanned (${codeScanSkipped.reason}: ${codeScanSkipped.message}) —` +
        ' run `lat check code-refs` for the fix.',
    );
  }

  if (codeRefs.length > 0) {
    parts.push('', '## Referenced by code:', '');
    for (const ref of codeRefs) {
      const codeRelPath = relative(
        process.cwd(),
        join(ctx.projectRoot, ref.file),
      );
      parts.push(
        `${s.dim('*')} ${s.cyan(codeRelPath)}${s.dim(`:${ref.line}`)}`,
      );
      if (ref.snippet) {
        const snippetLines = ref.snippet.split('\n');
        for (const line of snippetLines) {
          parts.push(`  ${s.dim('|')} ${line}`);
        }
      }
    }
  }

  parts.push(formatNavHints(ctx));

  return parts.join('\n');
}

export async function sectionCommand(
  ctx: CmdContext,
  query: string,
): Promise<CmdResult> {
  const result = await getSection(ctx, query);

  if (result.kind === 'no-match') {
    const s = ctx.styler;
    if (result.suggestions.length > 0) {
      const suggestions = result.suggestions
        .map(
          (m) =>
            `  ${s.dim('*')} ${s.white(m.section.id)} ${s.dim(`(${m.reason})`)}`,
        )
        .join('\n');
      return {
        output:
          s.red(`No section "${query}" found.`) +
          ' Did you mean:\n' +
          suggestions,
        isError: true,
      };
    }
    return {
      output: s.red(`No sections matching "${query}"`),
      isError: true,
    };
  }

  return { output: formatSectionOutput(ctx, result) };
}
