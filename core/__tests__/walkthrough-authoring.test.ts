import { expect, test } from 'vite-plus/test';
import {
  attachVersionCommentReferences,
  buildVersionCommitOverviewPrompt,
  buildWalkthroughPrompt,
  buildWalkthroughPromptInput,
  composeUnitWalkthroughs,
  indexWalkthroughHunks,
  normalizeWalkthroughDraft,
  parseWalkthroughDraft,
} from '../lib/walkthrough-authoring.ts';
import type { RepositoryState } from '../types.ts';

const state = {
  branch: 'feature/walkthrough',
  files: [
    {
      fingerprint: 'fingerprint',
      path: 'src/app.ts',
      sections: [
        {
          binary: false,
          id: 'src/app.ts:pull-request:42',
          kind: 'pull-request',
          patch:
            'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old();\n+newCall();\n@@ -10,0 +11 @@\n+test();\n',
        },
      ],
      status: 'modified',
    },
  ],
  generatedAt: Date.parse('2026-06-26T00:00:00.000Z'),
  launchPath: 'cloudflare/voidzero/codiff',
  root: 'cloudflare/voidzero/codiff',
  source: {
    headSha: 'head-sha',
    host: 'gitlab.example.com',
    number: 42,
    projectPath: 'cloudflare/voidzero/codiff',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/cloudflare/voidzero/codiff/-/merge_requests/42',
  },
} satisfies RepositoryState;

test('indexes stable hunk ids but sends compact aliases in the prompt', () => {
  const index = indexWalkthroughHunks(state.files);
  expect(index.hunks.map(({ id }) => id)).toEqual([
    'src/app.ts:pull-request:42:h1',
    'src/app.ts:pull-request:42:h2',
  ]);
  expect(index.hunkIdByAlias.get('h1')).toBe('src/app.ts:pull-request:42:h1');
  const prompt = buildWalkthroughPrompt(state);
  expect(prompt).toContain('"id":"h1"');
  expect(prompt).not.toContain('"id":"src/app.ts:pull-request:42:h1"');
  expect(prompt).toContain('compact request-local aliases');
  expect(prompt).toContain('Every stop must have a concise semantic title');
});

test('includes commit-by-commit strategy guidance in the walkthrough prompt', () => {
  const prompt = buildWalkthroughPrompt(state, {
    reviewStrategy: {
      commits: [
        {
          role: 'feature',
          shortSha: 'aaaaaaaa',
          subject: 'Add feature',
        },
      ],
      confidence: 0.9,
      mode: 'commit-by-commit',
      reason: 'stacked-subjects',
    },
  });
  expect(prompt).toContain('Review strategy is commit-by-commit');
  expect(prompt).toContain('Add feature');
});

test('normalizes draft aliases back onto live hunk ids and fills support', () => {
  const index = indexWalkthroughHunks(state.files);
  const walkthrough = normalizeWalkthroughDraft(
    {
      chapters: [
        {
          blurb: 'Core change',
          icon: 'path',
          id: 'c1',
          stops: [
            {
              hunkIds: ['h1'],
              id: 's1',
              importance: 'critical',
              prose: 'Explain the new call path.',
              title: 'New call path',
            },
          ],
          title: 'Core',
        },
      ],
      focus: 'Review the feature.',
      kind: 'narrative',
      title: 'Feature walkthrough',
      version: 4,
    },
    state,
    'codex',
  );
  expect(walkthrough.chapters[0]?.stops[0]?.hunkIds).toEqual([index.hunks[0]!.id]);
  expect(walkthrough.support.length).toBeGreaterThan(0);
  expect(walkthrough.support.some((item) => item.hunkIds.includes(index.hunks[1]!.id))).toBe(true);
});

test('accepts compact and legacy nullable draft shapes', () => {
  const compact = parseWalkthroughDraft({
    chapters: [
      {
        blurb: 'Core',
        icon: 'path',
        id: 'c1',
        stops: [
          {
            hunkIds: ['h1'],
            id: 's1',
            importance: 'normal',
            prose: 'Details',
            title: 'Title here',
          },
        ],
        title: 'Core',
      },
    ],
    focus: 'Focus',
    kind: 'narrative',
    title: 'Title',
    version: 4,
  });
  expect(compact.chapters[0]?.stops[0]?.title).toBe('Title here');

  const legacy = parseWalkthroughDraft({
    chapters: [
      {
        blurb: 'Core',
        icon: 'path',
        id: 'c1',
        stops: [
          {
            changeType: null,
            commitNote: null,
            hunkIds: ['h1'],
            id: 's1',
            importance: 'normal',
            notes: null,
            prose: 'Details',
            summary: null,
            title: null,
          },
        ],
        title: 'Core',
      },
    ],
    focus: 'Focus',
    kind: 'narrative',
    support: null,
    title: 'Title',
    version: 4,
  });
  expect(legacy.chapters[0]?.stops[0]?.hunkIds).toEqual(['h1']);
  expect(legacy.support).toBeUndefined();
});

test('attaches overlapping version comment references to stops', () => {
  const index = indexWalkthroughHunks(state.files);
  const walkthrough = normalizeWalkthroughDraft(
    {
      chapters: [
        {
          blurb: 'Core change',
          icon: 'path',
          id: 'c1',
          stops: [
            {
              hunkIds: [index.hunks[0]!.id],
              id: 's1',
              importance: 'critical',
              prose: 'Explain the new call path.',
              title: 'New call path',
            },
          ],
          title: 'Core',
        },
      ],
      focus: 'Review the feature.',
      kind: 'narrative',
      title: 'Feature walkthrough',
      version: 4,
    },
    state,
    'codex',
  );
  const withComments = attachVersionCommentReferences(walkthrough, [
    {
      authorName: 'Ada',
      body: 'Please rename this.',
      filePath: 'src/app.ts',
      id: 'c1',
      lineNumber: 1,
      status: 'still-valid',
    },
  ]);
  expect(withComments.chapters[0]?.stops[0]?.commentReferences?.[0]?.id).toBe('c1');
});

test('includes version-commit guidance and composes unit walkthroughs', () => {
  const prompt = buildWalkthroughPrompt(state, {
    versionCommitContext: {
      after: { shortSha: 'bbbbbbb', subject: 'Later' },
      before: { shortSha: 'aaaaaaa', subject: 'Earlier' },
      evolutionKind: 'likely-revised',
      kind: 'version-commit',
      range: { fromLabel: 'v1', toLabel: 'v2' },
      unitId: 'unit-1',
    },
    versionCompareRange: {
      fromLabel: 'v1',
      structure: 'commit-by-commit',
      toLabel: 'v2',
    },
  });
  expect(prompt).toContain('logical commit between v1 and v2');
  expect(prompt).toContain('Earlier');
  expect(prompt).toContain('Later');

  const unitWalkthrough = normalizeWalkthroughDraft(
    {
      chapters: [
        {
          blurb: 'Unit',
          icon: 'path',
          id: 'c1',
          stops: [
            {
              hunkIds: ['h1'],
              id: 's1',
              importance: 'normal',
              prose: 'Unit prose',
              title: 'Unit stop',
            },
          ],
          title: 'Unit',
        },
      ],
      focus: 'Unit focus',
      kind: 'narrative',
      title: 'Unit title',
      version: 4,
    },
    state,
    'codex',
  );
  const composed = composeUnitWalkthroughs({
    agent: 'codex',
    entries: [
      {
        context: {
          after: {
            sha: 'b'.repeat(40),
            shortSha: 'bbbbbbb',
            subject: 'Later',
          },
          kind: 'version-commit',
          range: { fromLabel: 'v1', toLabel: 'v2' },
          unitId: 'unit-1',
        },
        state,
        walkthrough: unitWalkthrough,
      },
    ],
    state,
  });
  expect(composed.chapters[0]?.id.startsWith('unit-1:')).toBe(true);
  expect(composed.commitFiles?.length).toBe(1);
  expect(composed.title).toContain('v1');
});

test('scopes version-comparison Review focus to changes since the earlier version', () => {
  const overviewPrompt = buildVersionCommitOverviewPrompt({
    entries: [
      {
        context: {
          after: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'Later' },
          evolutionKind: 'added',
          kind: 'version-commit',
          range: { fromLabel: 'v1', toLabel: 'v2' },
          unitId: 'unit-1',
        },
        state,
        walkthrough: null,
      },
    ],
    range: { fromLabel: 'v1', toLabel: 'v2' },
  });
  expect(overviewPrompt).toContain('strictly the changes since v1, through v2');
  expect(overviewPrompt).toContain('Do not summarize the merge request as a whole');
  expect(overviewPrompt).toContain('behavior already present in v1 as newly introduced');
});

test('exposes prompt digest sizing and patch budgets', () => {
  const { digest, patchBudgets, size } = buildWalkthroughPromptInput(state);
  expect(size.hunkCount).toBe(2);
  expect(digest.files[0]?.sections[0]?.hunks[0]?.id).toBe('h1');
  expect(patchBudgets.total).toBeGreaterThan(0);
});
