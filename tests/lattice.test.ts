import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatticeDir,
  listLatticeFiles,
  parseSections,
  buildFileIndex,
  resolveRef,
} from '../src/lattice.js';
import { toPosix } from '../src/walk.js';
import { rmDirBestEffort } from './util.js';

const basicDir = join(import.meta.dirname, 'cases', 'basic-project');
const basicLat = join(basicDir, 'lat.md');

describe('findLatticeDir', () => {
  it('finds .lat in the given directory', () => {
    expect(findLatticeDir(basicDir)).toBe(basicLat);
  });

  it('returns null when no .lat exists', () => {
    expect(findLatticeDir('/')).toBeNull();
  });

  // The upward walk is unbounded so a lat root can sit several levels above
  // cwd, but a `lat.md/` at or above $HOME would make every command anywhere
  // under it resolve a project root spanning the whole account — and the
  // code-ref scan then walks it. Home is where the walk stops.
  it('stops at the home directory rather than adopting a root above the repo', () => {
    const home = mkdtempSync(join(tmpdir(), 'lat-home-'));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      mkdirSync(join(home, 'lat.md'));
      const child = join(home, 'server', 'some', 'repo');
      mkdirSync(child, { recursive: true });

      expect(findLatticeDir(home)).toBeNull();
      expect(findLatticeDir(child)).toBeNull();

      // A graph below home still resolves normally.
      mkdirSync(join(home, 'server', 'some', 'repo', 'lat.md'));
      expect(findLatticeDir(child)).toBe(join(child, 'lat.md'));
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevProfile;
      rmDirBestEffort(home);
    }
  });
});

describe('listLatticeFiles', () => {
  it('lists .md files sorted alphabetically', async () => {
    const files = await listLatticeFiles(basicLat);
    expect(files).toEqual([
      join(basicLat, 'dev-process.md'),
      join(basicLat, 'notes.md'),
    ]);
  });
});

describe('parseSections', () => {
  it('handles multiple top-level headings', () => {
    const sections = parseSections('multi.md', '# First\n\n# Second\n');
    expect(sections).toHaveLength(2);
    expect(sections[0].id).toBe('multi#First');
    expect(sections[1].id).toBe('multi#Second');
  });

  it('uses file stem without .md extension', () => {
    const sections = parseSections('/path/to/notes.md', '# Hello');
    expect(sections[0].file).toBe('notes');
  });
});

describe('toPosix', () => {
  it('converts native backslash separators to forward slashes', () => {
    expect(toPosix('codigo\\codigo.md')).toBe('codigo/codigo.md');
    expect(toPosix('lat.md\\codigo\\a')).toBe('lat.md/codigo/a');
  });

  it('leaves POSIX paths unchanged', () => {
    expect(toPosix('lat.md/codigo/a')).toBe('lat.md/codigo/a');
    expect(toPosix('notes')).toBe('notes');
    expect(toPosix('')).toBe('');
  });
});

// Regression guard for issue #69: on Windows, section file paths kept the
// native `\` separator, so bare-name (`[[a]]`) links in a directory-index file
// never resolved. Section paths are now normalized to POSIX at construction, so
// this scenario resolves identically on every OS. The windows-latest CI job
// runs this same test on the platform where the bug originally manifested.
describe('bare-name link resolution in a subdirectory (issue #69)', () => {
  const root = join('/tmp', 'proj');
  const parse = (rel: string, body: string) =>
    parseSections(join(root, 'lat.md', rel), body, root);

  it('resolves short-form links to sibling files in the same subdir', () => {
    const sections = [
      ...parse('codigo/a.md', '# A\n\nAlpha.\n'),
      ...parse('codigo/b.md', '# B\n\nBravo.\n'),
      ...parse('codigo/codigo.md', '# Codigo\n\nDirectory index.\n'),
    ];

    // The invariant the fix enforces: stored paths are POSIX on every platform.
    expect(sections.map((s) => s.file)).toContain('lat.md/codigo/a');
    expect(sections.every((s) => !s.file.includes('\\'))).toBe(true);

    const fileIndex = buildFileIndex(sections);
    const sectionIds = new Set(sections.map((s) => s.id.toLowerCase()));

    for (const name of ['a', 'b']) {
      const { resolved, ambiguous } = resolveRef(name, sectionIds, fileIndex);
      expect(ambiguous).toBeNull();
      expect(sectionIds.has(resolved.toLowerCase())).toBe(true);
    }
  });
});
