import { expect, test } from 'vite-plus/test';
import {
  conflictResolutionFiles,
  pureRebaseFiles,
  pureRebaseVersions,
  rebasePlusEditFiles,
} from '../fixtures/version-compare-cases.ts';
import {
  applyUnifiedPatchBody,
  computeApproximatePatchTextVersionCompare,
  computeLineDiff,
  computeVersionComparePreferringReplay,
  computeRebaseReplayVersionCompare,
  materializeRebaseReplayTrees,
  type MergeRequestVersionRef,
  type VersionPatchFile,
} from '../src/version-compare.ts';

const version = (id: string, headSha: string, baseSha: string): MergeRequestVersionRef => ({
  baseSha,
  createdAt: '2026-07-01T00:00:00.000Z',
  headSha,
  id,
  label: `v${id}`,
  startSha: baseSha,
});

const patchFile = (
  path: string,
  body: string,
  status: VersionPatchFile['status'] = 'modified',
): VersionPatchFile => ({
  newPath: path,
  oldPath: path,
  patchBody: body,
  status,
});

test('approximate version comparison is empty for pure rebase (identical change regions)', () => {
  const body = '@@ -1 +1 @@\n-old\n+new\n';
  const result = computeApproximatePatchTextVersionCompare({
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [patchFile('src/app.ts', body)],
    to: version('2', 'head-b', 'base-b'),
    toFiles: [patchFile('src/app.ts', body)],
  });
  expect(result.summary.empty).toBe(true);
  expect(result.summary.intentionalFiles).toBe(0);
  expect(result.summary.baseMoved).toBe(true);
  expect(result.files).toEqual([]);
});

test('approximate version comparison surfaces intentional edits after rebase', () => {
  const result = computeApproximatePatchTextVersionCompare({
    comments: [
      {
        commentId: '42',
        filePath: 'src/app.ts',
        lineNumber: 2,
        position: {
          baseSha: 'base-a',
          headSha: 'head-a',
          startSha: 'base-a',
        },
      },
    ],
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new\n')],
    to: version('2', 'head-b', 'base-b'),
    toFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new and safer\n')],
  });
  expect(result.summary.empty).toBe(false);
  expect(result.summary.addedLines).toBe(1);
  expect(result.summary.deletedLines).toBe(1);
  expect(result.summary.intentionalFiles).toBe(1);
  expect(result.files[0]?.path).toBe('src/app.ts');
  expect(result.commentAssociations[0]?.status).toBe('resolved-by-change');
});

test('does not call a comment addressed when only another hunk in the file changed', () => {
  const comments = [
    {
      commentId: 'comment-100',
      filePath: 'src/app.ts',
      lineNumber: 100,
      position: { baseSha: 'base-a', headSha: 'head-a', startSha: 'base-a' },
    },
  ];
  const result = computeApproximatePatchTextVersionCompare({
    comments,
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [
      patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new\n@@ -100 +100 @@\n-keep\n+kept\n'),
    ],
    to: version('2', 'head-b', 'base-a'),
    toFiles: [
      patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+newer\n@@ -100 +100 @@\n-keep\n+kept\n'),
    ],
  });
  expect(result.commentAssociations[0]?.status).toBe('outdated');
});

test('rebase-replay version comparison diffs left vs right trees', () => {
  const from = version('1', 'head-a', 'base-shared');
  const to = version('2', 'head-b', 'base-shared');
  const result = computeRebaseReplayVersionCompare({
    from,
    fromTree: new Map([
      ['src/app.ts', 'const value = 1;\n'],
      ['README.md', 'hello\n'],
    ]),
    to,
    toTree: new Map([
      ['src/app.ts', 'const value = 2;\n'],
      ['README.md', 'hello\n'],
    ]),
  });
  expect(result.algorithm).toBe('jj-rebase-replay');
  expect(result.summary.filesChanged).toBe(1);
  expect(result.files[0]?.path).toBe('src/app.ts');
  expect(result.summary.baseMoved).toBe(false);
});

test('conflict markers are classified as conflict-resolution', () => {
  const result = computeApproximatePatchTextVersionCompare({
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new\n')],
    to: version('2', 'head-b', 'base-b'),
    toFiles: [
      patchFile('src/app.ts', '@@ -1,3 +1,5 @@\n<<<<<<<\n-old\n=======\n+resolved\n>>>>>>>\n'),
    ],
  });
  expect(result.files[0]?.classes).toContain('conflict-resolution');
  expect(result.summary.conflictFiles).toBe(1);
});

test('fixture: pure rebase yields empty intentional set', () => {
  const result = computeApproximatePatchTextVersionCompare({
    from: pureRebaseVersions.from,
    fromFiles: pureRebaseFiles.from,
    to: pureRebaseVersions.to,
    toFiles: pureRebaseFiles.to,
  });
  expect(result.summary.empty).toBe(true);
  expect(result.summary.intentionalFiles).toBe(0);
});

test('fixture: rebase plus edit surfaces only changed files', () => {
  const result = computeApproximatePatchTextVersionCompare({
    from: pureRebaseVersions.from,
    fromFiles: rebasePlusEditFiles.from,
    to: pureRebaseVersions.to,
    toFiles: rebasePlusEditFiles.to,
  });
  expect(result.summary.empty).toBe(false);
  expect(result.files.map((file) => file.path).toSorted()).toEqual(['README.md', 'src/app.ts']);
});

test('fixture: conflict resolution is high signal', () => {
  const result = computeApproximatePatchTextVersionCompare({
    from: pureRebaseVersions.from,
    fromFiles: conflictResolutionFiles.from,
    to: pureRebaseVersions.to,
    toFiles: conflictResolutionFiles.to,
  });
  expect(result.summary.conflictFiles).toBe(1);
  expect(result.files[0]?.classes).toContain('conflict-resolution');
});

test('applyUnifiedPatchBody applies a simple hunk', () => {
  const result = applyUnifiedPatchBody(
    'const value = 1;\nold();\n',
    '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n',
  );
  expect(result.conflict).toBe(false);
  expect(result.text).toBe('const value = 1;\nnewCall();\n');
});

test('applyUnifiedPatchBody reports conflicts on context mismatch', () => {
  const result = applyUnifiedPatchBody(
    'const value = 1;\nother();\n',
    '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n',
  );
  expect(result.conflict).toBe(true);
  expect(result.text).toContain('<<<<<<<');
});

test('preferring replay uses jj algorithm when blobs are available', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');
  const blobs = new Map<string, string>([
    ['base-b:src/app.ts', 'const value = 1;\nold();\n'],
    ['head-b:src/app.ts', 'const value = 1;\nnewCall();\nguard();\n'],
  ]);
  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [
      patchFile('src/app.ts', '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n'),
    ],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [
      patchFile(
        'src/app.ts',
        '@@ -1,2 +1,3 @@\n const value = 1;\n-old();\n+newCall();\n+guard();\n',
      ),
    ],
  });
  expect(result.algorithm).toBe('jj-rebase-replay');
  expect(result.summary.empty).toBe(false);
  expect(result.files[0]?.path).toBe('src/app.ts');
  // left = apply(from-patch onto base-b) => newCall only; right has guard
  expect(result.files[0]?.file.sections[0]?.patch).toContain('+guard();');
});

test('preferring replay falls back to approximate when patch reconstruction conflicts', async () => {
  const result = await computeVersionComparePreferringReplay({
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new\n')],
    readBlob: async () => null,
    to: version('2', 'head-b', 'base-b'),
    toFiles: [patchFile('src/app.ts', '@@ -1 +1 @@\n-old\n+new and safer\n')],
  });
  // Without blobs, patch reconstruction onto empty source conflicts.
  // The path is reported incomplete and falls back to approximate comparison.
  expect(result.algorithm).toBe('approximate-patch-text');
  expect(result.summary.empty).toBe(false);
});

test('preferring replay falls back when materialization cannot recover paths', async () => {
  const result = await computeVersionComparePreferringReplay({
    from: version('1', 'head-a', 'base-a'),
    fromFiles: [],
    readBlob: async () => null,
    to: version('2', 'head-b', 'base-b'),
    // Binary / empty patch with no blobs and no reconstructable body.
    toFiles: [
      {
        newPath: 'src/binary.bin',
        oldPath: 'src/binary.bin',
        patchBody: '',
        status: 'modified',
      },
    ],
  });
  expect(result.algorithm).toBe('approximate-patch-text');
  expect(result.warnings?.some((warning) => warning.includes('Fell back'))).toBe(true);
});

test('materialize trees rebases from-patch onto new base', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');
  const trees = await materializeRebaseReplayTrees({
    from,
    fromFiles: [
      patchFile('src/app.ts', '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n'),
    ],
    readBlob: (path, ref) => {
      if (ref === 'base-b' && path === 'src/app.ts') {
        return 'const value = 1;\nold();\n';
      }
      if (ref === 'head-b' && path === 'src/app.ts') {
        return 'const value = 1;\nnewCall();\n';
      }
      return null;
    },
    to,
    toFiles: [
      patchFile('src/app.ts', '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n'),
    ],
  });
  expect(trees.fromTree.get('src/app.ts')).toBe('const value = 1;\nnewCall();\n');
  expect(trees.toTree.get('src/app.ts')).toBe('const value = 1;\nnewCall();\n');
  expect(trees.incompletePaths).toEqual([]);
});

test('pure rebase with blobs yields empty versionCompare', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');
  const patch = '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n';
  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/app.ts', patch)],
    readBlob: (path, ref) => {
      if (path !== 'src/app.ts') {
        return null;
      }
      if (ref === 'base-b') {
        return 'const value = 1;\nold();\n';
      }
      if (ref === 'head-b') {
        return 'const value = 1;\nnewCall();\n';
      }
      return null;
    },
    to,
    toFiles: [patchFile('src/app.ts', patch)],
  });
  expect(result.algorithm).toBe('jj-rebase-replay');
  expect(result.summary.empty).toBe(true);
  expect(result.files).toEqual([]);
});

// === Regression tests (plan.md §4) ===

test('computeLineDiff: unchanged function in a changed file is excluded (Test A)', () => {
  // Two file versions where one hunk differs and an unchanged region
  // (apply_target_strategy) is identical. The localized diff must exclude
  // the unchanged region entirely.
  const left =
    [
      'fn setup() {',
      '    init();',
      '}',
      '',
      'fn apply_target_strategy() {',
      '    // complex logic',
      '    let x = compute();',
      '    validate(x);',
      '}',
      '',
      'fn teardown() {',
      '    cleanup();',
      '}',
    ].join('\n') + '\n';

  const right =
    [
      'fn setup() {',
      '    init();',
      '    extra_setup();',
      '}',
      '',
      'fn apply_target_strategy() {',
      '    // complex logic',
      '    let x = compute();',
      '    validate(x);',
      '}',
      '',
      'fn teardown() {',
      '    cleanup();',
      '}',
    ].join('\n') + '\n';

  const result = computeLineDiff(left, right);
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).not.toBe('');
  // The diff should contain the added line.
  expect(result.patchBody).toContain('+    extra_setup();');
  // The unchanged function must NOT appear as a changed line.
  expect(result.patchBody).not.toContain('+fn apply_target_strategy');
  expect(result.patchBody).not.toContain('-fn apply_target_strategy');
  expect(result.patchBody).not.toContain('+    let x = compute');
  expect(result.patchBody).not.toContain('-    let x = compute');
  expect(result.patchBody).not.toContain('+    validate(x)');
  expect(result.patchBody).not.toContain('-    validate(x)');
});

test('rebase-replay produces localized hunks for modified files (Test A end-to-end)', () => {
  const from = version('1', 'head-a', 'base-shared');
  const to = version('2', 'head-b', 'base-shared');
  const unchanged = [
    '',
    'fn apply_target_strategy() {',
    '    // complex logic',
    '    let x = compute();',
    '    validate(x);',
    '}',
  ].join('\n');

  const result = computeRebaseReplayVersionCompare({
    from,
    fromTree: new Map([['authority.rs', `fn setup() {\n    init();\n}${unchanged}\n`]]),
    to,
    toTree: new Map([
      ['authority.rs', `fn setup() {\n    init();\n    extra_setup();\n}${unchanged}\n`],
    ]),
  });
  expect(result.algorithm).toBe('jj-rebase-replay');
  expect(result.summary.filesChanged).toBe(1);
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  expect(patch).toContain('+    extra_setup();');
  // apply_target_strategy must not appear as a change.
  expect(patch).not.toContain('-fn apply_target_strategy');
  expect(patch).not.toContain('+fn apply_target_strategy');
  expect(patch).not.toContain('-    let x = compute');
  expect(patch).not.toContain('+    let x = compute');
});

test('large path count uses rebase-replay, not approximate fallback (Test B)', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');

  // Create 20 files — well above the old 12-path cutoff.
  const fromFiles: Array<ReturnType<typeof patchFile>> = [];
  const toFiles: Array<ReturnType<typeof patchFile>> = [];
  const blobs = new Map<string, string>();
  for (let i = 0; i < 20; i++) {
    const path = `src/file-${i}.ts`;
    fromFiles.push(patchFile(path, `@@ -1 +1 @@\n-old${i}\n+new${i}\n`));
    toFiles.push(patchFile(path, `@@ -1 +1 @@\n-old${i}\n+new${i} revised\n`));
    blobs.set(`base-b:${path}`, `old${i}\n`);
    blobs.set(`head-b:${path}`, `new${i} revised\n`);
  }

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles,
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles,
  });

  // Must use rebase-replay, NOT approximate-patch-text.
  expect(result.algorithm).toBe('jj-rebase-replay');
  // Should contain localized hunks (not whole-file replacements).
  expect(result.summary.filesChanged).toBe(20);
  // No warning about "patch-text version comparison because this range contains N files".
  expect(
    result.warnings?.some((w) => w.includes('patch-text version comparison because')),
  ).toBeFalsy();
});

test('likely-revised interdiff produces localized hunks (Test C)', async () => {
  // A likely-revised commit pair where one function changed and another did not.
  const from = version('old-sha', 'old-sha', 'old-parent');
  const to = version('new-sha', 'new-sha', 'new-parent');

  const unchangedFn = '\nfn untouched() {\n    stable_code();\n}\n';
  const fromPatch = `@@ -1,2 +1,2 @@\n fn main() {\n-    v1();\n+    v1_impl();\n`;
  const toPatch = `@@ -1,2 +1,2 @@\n fn main() {\n-    v1();\n+    v2_impl();\n`;

  const blobs = new Map<string, string>();
  blobs.set('new-parent:src/lib.rs', `fn main() {\n    v1();\n}${unchangedFn}`);
  blobs.set('new-sha:src/lib.rs', `fn main() {\n    v2_impl();\n}${unchangedFn}`);

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/lib.rs', fromPatch)],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [patchFile('src/lib.rs', toPatch)],
  });

  expect(result.algorithm).toBe('jj-rebase-replay');
  expect(result.summary.filesChanged).toBe(1);
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  // Should show the actual change.
  expect(patch).toContain('-    v1_impl();');
  expect(patch).toContain('+    v2_impl();');
  // The unchanged function must NOT appear as a change (+ or - prefix).
  // It may appear as context (space prefix) — that is acceptable per plan.md.
  expect(patch).not.toContain('-fn untouched');
  expect(patch).not.toContain('+fn untouched');
  expect(patch).not.toContain('-    stable_code');
  expect(patch).not.toContain('+    stable_code');
});

test('computeLineDiff handles identical files', () => {
  const result = computeLineDiff('hello\nworld\n', 'hello\nworld\n');
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).toBe('');
});

test('computeLineDiff handles empty-to-content', () => {
  const result = computeLineDiff('', 'new line\n');
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).toContain('+new line');
});

test('computeLineDiff handles content-to-empty', () => {
  const result = computeLineDiff('old line\n', '');
  expect(result.incomplete).toBe(false);
  expect(result.patchBody).toContain('-old line');
});

test('computeLineDiff produces multiple independent hunks', () => {
  // Two changes separated by many unchanged lines.
  const shared = Array.from({ length: 20 }, (_, i) => `line ${i + 2}`).join('\n');
  const left = `first\n${shared}\nlast\n`;
  const right = `FIRST\n${shared}\nLAST\n`;
  const result = computeLineDiff(left, right);
  expect(result.incomplete).toBe(false);
  // Should produce two separate hunks.
  const hunkHeaders = result.patchBody.match(/@@ /g);
  expect(hunkHeaders?.length).toBe(2);
});

test('rebase-replay: added file shows full addition patch (Test D)', () => {
  const from = version('1', 'head-a', 'base-shared');
  const to = version('2', 'head-b', 'base-shared');
  const result = computeRebaseReplayVersionCompare({
    from,
    fromTree: new Map(),
    to,
    toTree: new Map([['new-file.ts', 'export const x = 1;\n']]),
  });
  expect(result.summary.filesChanged).toBe(1);
  expect(result.files[0]?.status).toBe('added');
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  expect(patch).toContain('+export const x = 1;');
});

test('rebase-replay: removed file shows full deletion patch (Test D)', () => {
  const from = version('1', 'head-a', 'base-shared');
  const to = version('2', 'head-b', 'base-shared');
  const result = computeRebaseReplayVersionCompare({
    from,
    fromTree: new Map([['old-file.ts', 'export const y = 2;\n']]),
    to,
    toTree: new Map(),
  });
  expect(result.summary.filesChanged).toBe(1);
  expect(result.files[0]?.status).toBe('deleted');
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  expect(patch).toContain('-export const y = 2;');
});

test('rebase-replay reports incompleteDiffPaths for pathological diffs', () => {
  const from = version('1', 'head-a', 'base-shared');
  const to = version('2', 'head-b', 'base-shared');
  // Create two completely different files that exceed the Myers cap.
  const left = Array.from({ length: 1500 }, (_, i) => `unique-old-${i}`).join('\n') + '\n';
  const right = Array.from({ length: 1500 }, (_, i) => `unique-new-${i}`).join('\n') + '\n';
  const result = computeRebaseReplayVersionCompare({
    from,
    fromTree: new Map([['big.ts', left]]),
    to,
    toTree: new Map([['big.ts', right]]),
  });
  // The pathological diff should be reported as incomplete, not as a whole-file replacement.
  expect(result.incompleteDiffPaths).toContain('big.ts');
  expect(result.files.find((f) => f.path === 'big.ts')).toBeUndefined();
});

test('conflict during patch replay falls back to direct head blob comparison', async () => {
  // When replaying v11's patch onto v20's base produces a conflict (because
  // the base changed), we should fall back to comparing the actual v11 head
  // blob against the v20 head blob. This produces a real diff that may include
  // some base-change noise but never shows raw +/- patch syntax.
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');

  // The from-patch expects "old line" at line 1, but the new base has "different base line".
  const fromPatch = '@@ -1,2 +1,2 @@\n old line\n-remove me\n+add me\n';
  const toPatch = '@@ -1,2 +1,2 @@\n different base line\n-other\n+result\n';

  const blobs = new Map<string, string>();
  blobs.set('base-b:src/app.rs', 'different base line\nother\n');
  blobs.set('head-a:src/app.rs', 'old line\nadd me\n');
  blobs.set('head-b:src/app.rs', 'different base line\nresult\n');

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/app.rs', fromPatch)],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [patchFile('src/app.rs', toPatch)],
  });

  // Should still use rebase-replay algorithm (with blob fallback), not approximate.
  expect(result.algorithm).toBe('jj-rebase-replay');
  expect(result.summary.filesChanged).toBe(1);
  const patch = result.files[0]?.file.sections[0]?.patch ?? '';
  // Must never contain conflict markers.
  expect(patch).not.toContain('<<<<<<< source');
  expect(patch).not.toContain('>>>>>>> patch');
  // Should show the actual diff between head-a and head-b content.
  expect(patch).toContain('-old line');
  expect(patch).toContain('+different base line');
  // Warning should mention the replay conflict fallback.
  expect(result.warnings?.some((w) => w.includes('Replay conflict'))).toBe(true);
});

test('conflict during replay with no head blob falls back to approximate', async () => {
  const from = version('1', 'head-a', 'base-a');
  const to = version('2', 'head-b', 'base-b');

  const fromPatch = '@@ -1,2 +1,2 @@\n old line\n-remove me\n+add me\n';
  const toPatch = '@@ -1,2 +1,2 @@\n different base line\n-other\n+result\n';

  const blobs = new Map<string, string>();
  blobs.set('base-b:src/app.rs', 'different base line\nother\n');
  blobs.set('head-b:src/app.rs', 'different base line\nresult\n');
  // head-a blob NOT available — can't do direct comparison

  const result = await computeVersionComparePreferringReplay({
    from,
    fromFiles: [patchFile('src/app.rs', fromPatch)],
    readBlob: (path, ref) => blobs.get(`${ref}:${path}`) ?? null,
    to,
    toFiles: [patchFile('src/app.rs', toPatch)],
  });

  // Without head-a blob, path is incomplete → approximate fallback.
  // Must still never contain conflict markers.
  for (const file of result.files) {
    const patch = file.file.sections[0]?.patch ?? '';
    expect(patch).not.toContain('<<<<<<< source');
    expect(patch).not.toContain('>>>>>>> patch');
  }
});
