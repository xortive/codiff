/**
 * Deterministic walkthrough authoring: draft parsing, hunk indexing, prompt
 * construction, normalization, and unit composition.
 *
 * Hosts own model IDs, retries, and cache policy. This module owns shared
 * authoring semantics used by local Codiff and Codiff Web.
 */
import {
  array,
  boolean,
  type InferOutput,
  literal,
  looseObject,
  maxLength,
  maxValue,
  minLength,
  minValue,
  null_,
  number,
  object,
  optional,
  parse,
  picklist,
  pipe,
  safeParse,
  string,
  union,
} from 'valibot';
import type {
  ChangedFile,
  DiffSection,
  NarrativeWalkthrough,
  RepositoryState,
  VersionCommitKind,
  WalkthroughCommentReference,
  WalkthroughHunk,
} from '../types.ts';
import {
  getSectionWalkthroughHunks,
  isGeneratedWalkthroughPath,
} from './narrative-walkthrough-diff.js';

export const maxProseChars = 4000;
export const maxPatchExcerpt = 2500;
export const maxTotalPatchExcerpt = 60_000;
export const maxLargePatchExcerpt = 700;
export const maxLargeTotalPatchExcerpt = 35_000;
export const maxWalkthroughChapters = 20;
export const maxWalkthroughStops = 14;
export const maxHunksPerGroup = 14;

const boundedString = (maximum: number) => pipe(string(), maxLength(maximum));
const nonEmptyString = (maximum: number) => pipe(string(), minLength(1), maxLength(maximum));
const positiveInt = pipe(number(), minValue(1), maxValue(1_000_000_000));

const noteSchema = object({
  body: nonEmptyString(500),
  hunkId: nonEmptyString(200),
});

const reviewCommentSchema = looseObject({
  anchor: optional(picklist(['file', 'line'])),
  author: looseObject({
    avatarUrl: optional(string()),
    login: nonEmptyString(200),
    url: optional(string()),
  }),
  body: nonEmptyString(maxProseChars * 8),
  filePath: nonEmptyString(4096),
  id: nonEmptyString(200),
  isOutdated: optional(boolean()),
  lineNumber: optional(positiveInt),
  side: optional(picklist(['additions', 'deletions'])),
  startLineNumber: optional(positiveInt),
  startSide: optional(picklist(['additions', 'deletions'])),
  submittedAt: optional(string()),
  url: optional(string()),
});

const diffSectionSchema = looseObject({
  binary: boolean(),
  id: nonEmptyString(500),
  kind: picklist(['commit', 'pull-request', 'staged', 'unstaged']),
  patch: string(),
});

const changedFileSchema = looseObject({
  fingerprint: nonEmptyString(256),
  oldPath: optional(string()),
  path: nonEmptyString(4096),
  sections: array(diffSectionSchema),
  status: picklist(['added', 'deleted', 'modified', 'renamed', 'untracked']),
});

const pullRequestSourceSchema = looseObject({
  type: literal('pull-request'),
  url: nonEmptyString(2048),
});

const genericSourceSchema = looseObject({
  type: picklist([
    'working-tree',
    'commit',
    'branch',
    'branch-diff',
    'branch-working-tree',
    'range',
    'pull-request',
  ]),
});

export const repositoryStateSchema = looseObject({
  branch: union([string(), null_()]),
  files: array(changedFileSchema),
  generatedAt: number(),
  launchPath: string(),
  reviewComments: optional(array(reviewCommentSchema)),
  root: string(),
  source: union([pullRequestSourceSchema, genericSourceSchema]),
});

const changeTypeSchema = picklist([
  'fix',
  'feature',
  'refactor',
  'test',
  'generated',
  'lockfile',
  'snapshot',
  'i18n',
  'docs',
]);

const groupFields = {
  changeType: optional(changeTypeSchema),
  commitNote: optional(boundedString(1000)),
  hunkIds: pipe(array(nonEmptyString(200)), minLength(1), maxLength(maxHunksPerGroup)),
  id: nonEmptyString(100),
  notes: optional(pipe(array(noteSchema), maxLength(maxHunksPerGroup))),
  summary: optional(boundedString(1000)),
  title: optional(boundedString(200)),
};

const stopSchema = object({
  ...groupFields,
  importance: picklist(['critical', 'normal', 'context']),
  prose: nonEmptyString(4000),
});

const supportSchema = object({
  ...groupFields,
  note: optional(boundedString(2000)),
  reason: nonEmptyString(200),
});

export const walkthroughDraftSchema = object({
  chapters: pipe(
    array(
      object({
        blurb: boundedString(1000),
        icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
        id: nonEmptyString(100),
        stops: pipe(array(stopSchema), maxLength(maxWalkthroughStops)),
        title: nonEmptyString(16),
      }),
    ),
    minLength(1),
    maxLength(maxWalkthroughChapters),
  ),
  focus: nonEmptyString(2000),
  kind: literal('narrative'),
  support: optional(pipe(array(supportSchema), maxLength(30))),
  title: nonEmptyString(200),
  version: literal(4),
});

export type WalkthroughDraft = InferOutput<typeof walkthroughDraftSchema>;

/** @deprecated Prefer WalkthroughDraft. */
export type AuthoredWalkthrough = WalkthroughDraft;

const nullableGroupFields = {
  changeType: optional(union([changeTypeSchema, null_()])),
  commitNote: optional(union([boundedString(1000), null_()])),
  hunkIds: groupFields.hunkIds,
  id: groupFields.id,
  notes: optional(union([pipe(array(noteSchema), maxLength(maxHunksPerGroup)), null_()])),
  summary: optional(union([boundedString(1000), null_()])),
  title: optional(union([boundedString(200), null_()])),
};

const legacyWalkthroughDraftSchema = object({
  chapters: pipe(
    array(
      object({
        blurb: boundedString(1000),
        icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
        id: nonEmptyString(100),
        stops: pipe(
          array(
            object({
              ...nullableGroupFields,
              importance: picklist(['critical', 'normal', 'context']),
              prose: nonEmptyString(4000),
            }),
          ),
          maxLength(maxWalkthroughStops),
        ),
        title: nonEmptyString(16),
      }),
    ),
    minLength(1),
    maxLength(maxWalkthroughChapters),
  ),
  focus: nonEmptyString(2000),
  kind: literal('narrative'),
  support: optional(
    union([
      pipe(
        array(
          object({
            ...nullableGroupFields,
            note: optional(union([boundedString(2000), null_()])),
            reason: nonEmptyString(200),
          }),
        ),
        maxLength(30),
      ),
      null_(),
    ]),
  ),
  title: nonEmptyString(200),
  version: literal(4),
});

const compactWalkthroughDraftSchema = object({
  chapters: pipe(
    array(
      object({
        blurb: boundedString(1000),
        icon: picklist(['bug', 'wrench', 'path', 'flask', 'beaker', 'doc', 'gear']),
        id: nonEmptyString(100),
        stops: pipe(
          array(
            object({
              hunkIds: groupFields.hunkIds,
              id: groupFields.id,
              importance: picklist(['critical', 'normal', 'context']),
              prose: nonEmptyString(4000),
              title: nonEmptyString(80),
            }),
          ),
          maxLength(maxWalkthroughStops),
        ),
        title: nonEmptyString(16),
      }),
    ),
    minLength(1),
    maxLength(maxWalkthroughChapters),
  ),
  focus: nonEmptyString(2000),
  kind: literal('narrative'),
  title: nonEmptyString(200),
  version: literal(4),
});

/** Agent structured-output schema shape for hosts that need a JSON schema later. */
export const walkthroughDraftAgentOutputSchema = compactWalkthroughDraftSchema;

const compactNullableGroup = (group: {
  changeType?: string | null;
  commitNote?: string | null;
  hunkIds: ReadonlyArray<string>;
  id: string;
  notes?: ReadonlyArray<{ body: string; hunkId: string }> | null;
  summary?: string | null;
  title?: string | null;
}) => ({
  ...(group.changeType
    ? {
        changeType: group.changeType as NonNullable<
          WalkthroughDraft['chapters'][number]['stops'][number]['changeType']
        >,
      }
    : {}),
  ...(group.commitNote ? { commitNote: group.commitNote } : {}),
  hunkIds: [...group.hunkIds],
  id: group.id,
  ...(group.notes ? { notes: [...group.notes] } : {}),
  ...(group.summary ? { summary: group.summary } : {}),
  ...(group.title ? { title: group.title } : {}),
});

export const parseWalkthroughDraft = (value: unknown): WalkthroughDraft => {
  const authored = safeParse(walkthroughDraftSchema, value);
  if (authored.success) {
    return authored.output;
  }

  const legacyOutput = safeParse(legacyWalkthroughDraftSchema, value);
  if (legacyOutput.success) {
    return {
      chapters: legacyOutput.output.chapters.map((chapter) => ({
        blurb: chapter.blurb,
        icon: chapter.icon,
        id: chapter.id,
        stops: chapter.stops.map((stop) => ({
          ...compactNullableGroup(stop),
          importance: stop.importance,
          prose: stop.prose,
        })),
        title: chapter.title,
      })),
      focus: legacyOutput.output.focus,
      kind: legacyOutput.output.kind,
      ...(Array.isArray(legacyOutput.output.support)
        ? {
            support: legacyOutput.output.support.map((item) => ({
              ...compactNullableGroup(item),
              ...(item.note ? { note: item.note } : {}),
              reason: item.reason,
            })),
          }
        : {}),
      title: legacyOutput.output.title,
      version: legacyOutput.output.version,
    };
  }

  const output = parse(compactWalkthroughDraftSchema, value);
  return {
    chapters: output.chapters.map((chapter) => ({
      blurb: chapter.blurb,
      icon: chapter.icon,
      id: chapter.id,
      stops: chapter.stops.map((stop) => ({
        hunkIds: [...stop.hunkIds],
        id: stop.id,
        importance: stop.importance,
        prose: stop.prose,
        title: stop.title,
      })),
      title: chapter.title,
    })),
    focus: output.focus,
    kind: output.kind,
    title: output.title,
    version: output.version,
  };
};

/** @deprecated Prefer parseWalkthroughDraft. */
export const parseAuthoredWalkthrough = parseWalkthroughDraft;

export const parseRepositoryState = (value: unknown): RepositoryState =>
  parse(repositoryStateSchema, value) as RepositoryState;

export type WalkthroughReviewStrategy =
  | {
      commits: ReadonlyArray<{
        role: string;
        shortSha: string;
        subject: string;
      }>;
      confidence: number;
      mode: 'commit-by-commit';
      reason: string;
    }
  | {
      confidence: number;
      mode: 'whole-diff' | 'whole-mr';
      reason: string;
    };

type IndexedHunk = WalkthroughHunk & {
  sectionId: string;
  sectionKind: 'pull-request';
};

type SectionWalkthroughHunk = ReturnType<typeof getSectionWalkthroughHunks>[number];

const defaultSideForStatus = (status: ChangedFile['status']) =>
  status === 'added' || status === 'untracked'
    ? ('additions' as const)
    : status === 'deleted'
      ? ('deletions' as const)
      : ('both' as const);

const createIndexedHunk = (
  file: ChangedFile,
  section: DiffSection,
  hunk: SectionWalkthroughHunk,
): IndexedHunk => {
  const patchHunk = 'additionStart' in hunk ? hunk : null;
  const startLine = patchHunk
    ? patchHunk.added > 0
      ? patchHunk.additionStart
      : patchHunk.deletionStart
    : undefined;
  const endLine = patchHunk
    ? patchHunk.added > 0
      ? patchHunk.additionEnd
      : patchHunk.deletionEnd
    : undefined;
  const display =
    startLine == null
      ? file.path
      : startLine === endLine
        ? `${file.path}:${startLine}`
        : `${file.path}:${startLine}-${endLine}`;

  return {
    added: hunk.added,
    ...(patchHunk ? { additionEnd: patchHunk.additionEnd } : {}),
    ...(patchHunk ? { additionStart: patchHunk.additionStart } : {}),
    anchor: {
      display,
      ...(endLine != null ? { endLine } : {}),
      sectionId: section.id,
      sectionKind: section.kind,
      side: defaultSideForStatus(file.status),
      ...(startLine != null ? { startLine } : {}),
    },
    deleted: hunk.deleted,
    ...(patchHunk ? { deletionEnd: patchHunk.deletionEnd } : {}),
    ...(patchHunk ? { deletionStart: patchHunk.deletionStart } : {}),
    id: hunk.id,
    kind: patchHunk ? 'patch' : 'synthetic',
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    path: file.path,
    sectionId: section.id,
    sectionKind: 'pull-request',
    status: file.status,
  };
};

const indexFileHunks = (file: ChangedFile): Array<IndexedHunk> =>
  file.sections.flatMap((section) =>
    getSectionWalkthroughHunks(file, section).map((hunk) => createIndexedHunk(file, section, hunk)),
  );

export const indexWalkthroughHunks = (files: ReadonlyArray<ChangedFile>) => {
  const hunks = files.flatMap(indexFileHunks);
  const byId = new Map<string, IndexedHunk>();
  const aliasByHunkId = new Map<string, string>();
  const hunkIdByAlias = new Map<string, string>();
  hunks.forEach((hunk, index) => {
    const alias = `h${index + 1}`;
    byId.set(hunk.id, hunk);
    byId.set(alias, hunk);
    aliasByHunkId.set(hunk.id, alias);
    hunkIdByAlias.set(alias, hunk.id);
  });
  return {
    aliasByHunkId,
    byId,
    hunkIdByAlias,
    hunks,
  };
};

const lineCounts = (hunks: ReadonlyArray<IndexedHunk>) =>
  hunks.reduce(
    (total, hunk) => ({
      added: total.added + hunk.added,
      deleted: total.deleted + hunk.deleted,
    }),
    { added: 0, deleted: 0 },
  );

const clean = (value: string, fallback = '') => value.trim() || fallback;

export const normalizeWalkthroughDraft = (
  value: unknown,
  state: RepositoryState,
  agent: NarrativeWalkthrough['agent'],
): NarrativeWalkthrough => {
  const authored = parseWalkthroughDraft(value);
  const index = indexWalkthroughHunks(state.files);
  const used = new Set<string>();
  const itemIds = new Set<string>();

  const resolveGroup = (
    group:
      | WalkthroughDraft['chapters'][number]['stops'][number]
      | NonNullable<WalkthroughDraft['support']>[number],
  ) => {
    if (itemIds.has(group.id)) {
      return null;
    }
    const groupHunkIds = new Set<string>();
    const hunks = group.hunkIds.flatMap((id) => {
      const hunk = index.byId.get(id);
      if (!hunk || used.has(hunk.id) || groupHunkIds.has(hunk.id)) {
        return [];
      }
      groupHunkIds.add(hunk.id);
      return [hunk];
    });
    if (hunks.length === 0) {
      return null;
    }
    hunks.forEach((hunk) => used.add(hunk.id));
    itemIds.add(group.id);
    const counts = lineCounts(hunks);
    const hunkIds = hunks.map((hunk) => hunk.id);
    return {
      ...counts,
      ...(group.changeType
        ? {
            changeType: group.changeType as NonNullable<
              WalkthroughDraft['chapters'][number]['stops'][number]['changeType']
            >,
          }
        : {}),
      ...(group.commitNote ? { commitNote: clean(group.commitNote) } : {}),
      hunkIds,
      hunks,
      id: group.id,
      ...(group.notes
        ? {
            notes: group.notes
              .map((note) => ({
                ...note,
                hunkId: index.byId.get(note.hunkId)?.id ?? note.hunkId,
              }))
              .filter(
                (note, noteIndex, notes) =>
                  hunkIds.includes(note.hunkId) &&
                  notes.findIndex((candidate) => candidate.hunkId === note.hunkId) === noteIndex,
              ),
          }
        : {}),
      ...(group.summary ? { summary: clean(group.summary) } : {}),
      ...(group.title ? { title: clean(group.title) } : {}),
    };
  };

  const chapters = authored.chapters.flatMap((chapter) => {
    const stops = chapter.stops.flatMap((stop) => {
      const group = resolveGroup(stop);
      return group
        ? [
            {
              ...group,
              importance: stop.importance,
              prose: clean(stop.prose),
            },
          ]
        : [];
    });
    return stops.length > 0
      ? [
          {
            blurb: clean(chapter.blurb),
            icon: chapter.icon,
            id: chapter.id,
            stops,
            title: clean(chapter.title, 'Review'),
          },
        ]
      : [];
  });
  if (chapters.length === 0) {
    throw new Error('The generated walkthrough did not reference any current diff hunks.');
  }

  const support = (authored.support ?? []).flatMap((item) => {
    const group = resolveGroup(item);
    return group
      ? [
          {
            ...group,
            ...(item.note ? { note: clean(item.note) } : {}),
            reason: clean(item.reason, 'Other changes'),
          },
        ]
      : [];
  });
  const remainingByPath = new Map<string, Array<IndexedHunk>>();
  for (const hunk of index.hunks) {
    if (!used.has(hunk.id)) {
      remainingByPath.set(hunk.path, [...(remainingByPath.get(hunk.path) ?? []), hunk]);
    }
  }
  for (const [path, hunks] of remainingByPath) {
    for (let start = 0; start < hunks.length; start += maxHunksPerGroup) {
      const chunk = hunks.slice(start, start + maxHunksPerGroup);
      const counts = lineCounts(chunk);
      let supportId = `support-${support.length + 1}`;
      while (itemIds.has(supportId)) {
        supportId = `support-${Number(supportId.slice('support-'.length)) + 1}`;
      }
      support.push({
        ...counts,
        hunkIds: chunk.map((hunk) => hunk.id),
        hunks: chunk,
        id: supportId,
        reason: 'Other changes',
        title: path,
      });
      itemIds.add(supportId);
    }
  }
  const stopCount = chapters.reduce((count, chapter) => count + chapter.stops.length, 0);
  return {
    agent,
    chapters,
    focus: clean(authored.focus, 'Walk through the merge request.'),
    generatedAt: new Date().toISOString(),
    kind: 'narrative',
    meta: `${stopCount} stops · ${chapters.length} chapters`,
    repo: {
      branch: state.branch,
      root: state.root,
    },
    source: state.source,
    support,
    title: clean(authored.title, 'Merge request walkthrough'),
    version: 4,
  };
};

const truncate = (value: string, maxLength: number) =>
  value.length <= maxLength
    ? value
    : maxLength <= 1
      ? value.slice(0, maxLength)
      : `${value.slice(0, maxLength - 1)}…`;

const getPromptPatchBudgets = (fileCount: number) =>
  fileCount > 32
    ? { section: maxLargePatchExcerpt, total: maxLargeTotalPatchExcerpt }
    : { section: maxPatchExcerpt, total: maxTotalPatchExcerpt };

const buildPatchExcerpt = (
  section: DiffSection,
  remainingBudget: number,
  sectionBudget: number,
) => {
  const summary = section.summary?.reason ? `Summary: ${section.summary.reason}\n` : '';
  const patch = `${summary}${section.patch || ''}`;
  if (!patch) {
    return '[patch omitted: no text patch available]';
  }
  const maxLength = Math.max(0, Math.min(sectionBudget, remainingBudget));
  return truncate(patch, maxLength);
};

const formatPromptLineRange = (start: number, end: number) =>
  start === end ? `${start}` : `${start}-${end}`;

const buildPromptHunk = (hunk: IndexedHunk, id: string) =>
  hunk.kind === 'synthetic'
    ? {
        added: hunk.added,
        deleted: hunk.deleted,
        id,
        kind: 'synthetic' as const,
      }
    : {
        added: hunk.added,
        deleted: hunk.deleted,
        id,
        kind: 'patch' as const,
        newLines: formatPromptLineRange(hunk.additionStart ?? 0, hunk.additionEnd ?? 0),
        oldLines: formatPromptLineRange(hunk.deletionStart ?? 0, hunk.deletionEnd ?? 0),
      };

type WalkthroughSize = {
  fileCount: number;
  hunkCount: number;
};

const buildWalkthroughSizingGuidance = (
  { fileCount, hunkCount }: WalkthroughSize,
  { independentCommit = false }: { independentCommit?: boolean } = {},
) => {
  const targetStops =
    fileCount <= 2
      ? hunkCount <= 4
        ? '1-2'
        : '2-3'
      : fileCount <= 4 && hunkCount <= 4
        ? '1-2'
        : fileCount <= 4 && hunkCount <= 8
          ? '1-3'
          : fileCount <= 16
            ? '5-9'
            : '6-9';
  const targetChapters = fileCount <= 2 ? '1' : fileCount <= 4 && hunkCount <= 8 ? '1-2' : '2-6';

  return `Coverage contract:
- The digest has ${fileCount} files and ${hunkCount} reviewable hunks. Put only the highest-leverage review path in chapters[]; Codiff preserves everything else as support.
- Digest hunk ids are compact request-local aliases like h1 and h2. Return those aliases exactly; Codiff maps them back to stable live-diff ids.
- Define chapters[] and stops[] in display order. Use stable stop ids like s1, s2, and never invent hunk ids.
${
  independentCommit
    ? '- Choose as many conceptual chapters as this commit needs. Do not collapse distinct review ideas into one chapter.'
    : `- Target ${targetStops} main-path stops and at most ${maxWalkthroughStops}. Use ${targetChapters} conceptual chapters.`
}
- Chapter titles render in a compact top bar: keep each title to 1-2 short words and at most 16 characters.
- Default to one review idea per stop. Group multiple hunkIds when they implement the same invariant, behavior, or repeated pattern.
- Every stop must have a concise semantic title that names the review idea in roughly 2-6 words, e.g. "Prevent duplicate payments" or "Preserve offline drafts". Never use a filename or path as a stop title.
- A stop may contain at most ${maxHunksPerGroup} hunkIds, listed in the exact display order Codiff should render.
- Generated-like files have "generated":true and one synthetic hunk per changed section. Never split them; main-path them only when they explain behavior.
- Leave secondary, mechanical, docs-only, generated, styling, fixture, lockfile, snapshot, and repeated-pattern hunks out of chapters[]. Codiff automatically places every unreferenced hunk in support.
- Do not provide support, added/deleted counts, status, paths, section ids, repo, source, generatedAt, agent, meta, notes, changeType, summary, or commitNote for stops; Codiff computes display metadata from the live diff.`;
};

// Prompt shaping for commit-aware / version-comparison walkthroughs.
// Options flow: fate generateWalkthrough → walkthrough-agent.generate → buildWalkthroughPrompt.
export type WalkthroughPromptOptions = {
  /** When set, the digest contains exactly one commit and is authored independently. */
  commitContext?: {
    sha: string;
    subject: string;
  } | null;
  reviewStrategy?: WalkthroughReviewStrategy | null;
  versionBaseContext?: {
    absorbedCommits: ReadonlyArray<{
      baseShortSha?: string;
      shortSha: string;
      subject: string;
    }>;
    commits: ReadonlyArray<{ shortSha: string; subject: string }>;
    relationship: 'forward' | 'backward' | 'divergent' | 'unknown';
  } | null;
  versionCommentReferences?: ReadonlyArray<WalkthroughCommentReference> | null;
  /** One changed logical commit unit inside a selected version range. */
  versionCommitContext?: {
    after?: { shortSha: string; subject: string };
    before?: { shortSha: string; subject: string };
    evolutionKind: 'likely-revised' | 'added' | 'removed' | 'ambiguous';
    kind: 'version-commit';
    range: { fromLabel: string; toLabel: string };
    rebaseDrivers?: ReadonlyArray<{
      authorName: string;
      overlappingPaths: ReadonlyArray<string>;
      shortSha: string;
      subject: string;
    }>;
    unitId: string;
  } | null;
  /** When set, author a walkthrough of MR version evolution, not the whole net MR. */
  versionCompareRange?: {
    fromLabel: string;
    structure?: 'commit-by-commit' | 'whole-diff';
    toLabel: string;
  } | null;
};

const commentTouchesHunk = (comment: WalkthroughCommentReference, hunk: WalkthroughHunk) => {
  if (comment.filePath !== hunk.path && comment.filePath !== hunk.oldPath) {
    return false;
  }
  if (comment.lineNumber == null) {
    return true;
  }
  const line = comment.lineNumber;
  return (
    (hunk.additionStart != null &&
      hunk.additionEnd != null &&
      line >= hunk.additionStart - 2 &&
      line <= hunk.additionEnd + 2) ||
    (hunk.deletionStart != null &&
      hunk.deletionEnd != null &&
      line >= hunk.deletionStart - 2 &&
      line <= hunk.deletionEnd + 2)
  );
};

export const attachVersionCommentReferences = (
  walkthrough: NarrativeWalkthrough,
  comments: ReadonlyArray<WalkthroughCommentReference> | null | undefined,
): NarrativeWalkthrough =>
  !comments?.length
    ? walkthrough
    : {
        ...walkthrough,
        chapters: walkthrough.chapters.map((chapter) => ({
          ...chapter,
          stops: chapter.stops.map((stop) => {
            const commentReferences = comments.filter((comment) =>
              stop.hunks.some((hunk) => commentTouchesHunk(comment, hunk)),
            );
            return commentReferences.length ? { ...stop, commentReferences } : stop;
          }),
        })),
      };

const buildReviewStrategyDigest = (strategy: WalkthroughReviewStrategy | null | undefined) => {
  if (!strategy) {
    return null;
  }
  if (strategy.mode === 'commit-by-commit') {
    return {
      commits: strategy.commits.map((commit) => ({
        role: commit.role,
        sha: commit.shortSha,
        subject: truncate(commit.subject, 120),
      })),
      confidence: strategy.confidence,
      mode: strategy.mode,
      reason: strategy.reason,
    };
  }
  return {
    confidence: strategy.confidence,
    mode: strategy.mode === 'whole-mr' ? 'whole-diff' : strategy.mode,
    reason: strategy.reason,
  };
};

const buildCommitStructureGuidance = (strategy: WalkthroughReviewStrategy | null | undefined) => {
  if (!strategy || strategy.mode !== 'commit-by-commit') {
    return `- Prefer conceptual chapters across the net merge-request diff.
- A commit list may be present as weak author history context; do not structure the walkthrough around fixups or review-response commits.
- Do not invent commit metadata that is not in the digest.`;
  }
  return `- Review strategy is commit-by-commit (${strategy.reason}).
- Preserve distinct review ideas as separate chapters; there is no one-chapter-per-commit limit.
- Stop titles must stay semantic, but may reference the related commit subject.
- Digest hunks still come from the live whole-MR diff for stable anchors; optionally mention commit subjects in prose when they clarify chapter boundaries.
- Include every non-merge commit in its own boundary; do not group commits.`;
};

const buildVersionCompareStructureGuidance = (
  versionCompareRange: WalkthroughPromptOptions['versionCompareRange'],
) => {
  if (!versionCompareRange) {
    return '';
  }
  const structureLabel =
    versionCompareRange.structure === 'commit-by-commit'
      ? 'commit-by-commit'
      : versionCompareRange.structure === 'whole-diff'
        ? 'whole-diff'
        : null;
  return `- This walkthrough covers the version comparison from ${versionCompareRange.fromLabel} to ${versionCompareRange.toLabel}${structureLabel ? ` as a ${structureLabel} walkthrough` : ''}.
- Focus on how the merge request itself evolved: intentional edits, conflict-resolution fallout, and newly added/removed behavior.
- Do not narrate pure rebase noise. Prefer chapters that answer "what changed since the earlier version?" for a returning reviewer.
- Hunks still come from the supplied digest; treat them as the version-comparison surface, not the full historical MR net diff.${
    structureLabel === 'commit-by-commit'
      ? '\n- This request is one unit inside a commit-by-commit version walkthrough; stay scoped to the supplied unit.'
      : structureLabel === 'whole-diff'
        ? '\n- This is a whole-diff version walkthrough across the intentional version-comparison surface.'
        : ''
  }`;
};

const buildVersionBaseGuidance = (context: WalkthroughPromptOptions['versionBaseContext']) => {
  if (!context) {
    return '';
  }
  const absorbed = context.absorbedCommits
    .map(
      (commit) =>
        `  - ${commit.shortSha}: ${commit.subject}${commit.baseShortSha ? ` (now in base as ${commit.baseShortSha})` : ''}`,
    )
    .join('\n');
  const baseCommits = context.commits
    .slice(0, 12)
    .map((commit) => `  - ${commit.shortSha}: ${commit.subject}`)
    .join('\n');
  return `- The target base changed between these versions (${context.relationship}).
${
  absorbed
    ? `- These earlier MR commits are now supplied by the target base. Do not describe their behavior as removed:
${absorbed}`
    : '- No earlier MR commits were confidently identified as moving into the target base.'
}
- Base commits are context only. Mention them only when the supplied version diff demonstrates an adaptation:
${baseCommits || '  - none available'}`;
};

const buildVersionCommentGuidance = (
  comments: WalkthroughPromptOptions['versionCommentReferences'],
) => {
  if (!comments?.length) {
    return '';
  }
  return `- The digest includes review comments anchored to this version comparison.
- Mention a comment when its code region is part of the reviewer path.
- Say a comment was addressed only when its status is resolved-by-change; otherwise describe it as related context.`;
};

const buildSingleCommitGuidance = (commit: WalkthroughPromptOptions['commitContext']) => {
  if (!commit) {
    return '';
  }
  return `- This is an independent walkthrough for commit ${commit.sha}: ${commit.subject}.
- Explain only the changes introduced by this commit. Do not summarize the merge request as a whole.
- Never refer to earlier or later commits, the commit stack, a rebase, or cumulative merge-request history.
- Do not infer behavior from code outside this commit's supplied diff.
- Build the best reviewer path through this commit's own diff.`;
};

const buildVersionCommitGuidance = (context: WalkthroughPromptOptions['versionCommitContext']) => {
  if (!context) {
    return '';
  }
  const before = context.before ? `${context.before.shortSha}: ${context.before.subject}` : 'none';
  const after = context.after ? `${context.after.shortSha}: ${context.after.subject}` : 'none';
  if (context.evolutionKind === 'added') {
    return `- This is one commit added between ${context.range.fromLabel} and ${context.range.toLabel}: ${after}.
- Explain only this new commit's own contribution. Do not summarize the complete version range.`;
  }
  if (context.evolutionKind === 'removed') {
    return `- This commit was removed from the MR stack between ${context.range.fromLabel} and ${context.range.toLabel}: ${before}.
- The supplied diff is intentionally inverted. Explain what was removed from the MR, never as newly authored implementation.`;
  }
  if (context.evolutionKind === 'ambiguous') {
    return `- GitLab commit changes could not be paired confidently between ${context.range.fromLabel} and ${context.range.toLabel}.
- This fallback contains authoritative whole-range effects not safely attributable to one logical commit.
- Explain these as other stack changes and do not invent commit identity.`;
  }
  const drivers = context.rebaseDrivers ?? [];
  if (drivers.length === 0) {
    return `- This is the change to one logical commit between ${context.range.fromLabel} and ${context.range.toLabel}.
- Earlier commit: ${before}. Later commit: ${after}.
- Explain only the supplied patch evolution, not the complete later commit or changes in other commits.
- This pairing is heuristic. Never claim the two SHAs are exactly the same commit.
- If the patch looks like conflict resolution or context-line churn, say the rewrite may be rebase fallout, but only when the supplied hunks support that reading.
- Do not invent base-branch commits that are not listed in the digest.
- Treat the supplied hunks as the source of truth.`;
  }
  const primary = drivers[0]!;
  const driverLines = drivers
    .map(
      (driver) =>
        `  - ${driver.shortSha}: ${driver.subject} (by ${driver.authorName}; overlaps ${driver.overlappingPaths.slice(0, 4).join(', ')}${driver.overlappingPaths.length > 4 ? ', …' : ''})`,
    )
    .join('\n');
  return `- This is a REBASE-REVISED logical commit between ${context.range.fromLabel} and ${context.range.toLabel}.
- Earlier commit: ${before}. Later commit: ${after}.
- Opening requirement: the first sentence of the first chapter blurb MUST start from the base-branch update that this rebase pulled in, using this shape:
  "Because this rebase brought in ${primary.shortSha} (${primary.subject}) from the base branch, this MR commit was revised to …"
- Preferred primary driver: ${primary.shortSha} — ${primary.subject}.
- All attributed base-branch commits brought in by the rebase:
${driverLines}
- After that opening sentence, explain only the supplied patch evolution for this logical commit.
- Distinguish clearly:
  1) adaptations required because the rebase moved the MR onto newer base-branch commits, versus
  2) intentional new MR behavior not explained by those base-branch commits.
- Do not narrate the entire base branch; only the listed base commits that the rebase introduced under this MR commit.
- Prefer wording like "brought in by the rebase", "now present on the updated base", or "required after rebasing onto newer base commits". Avoid "landed by rebase".
- This pairing is heuristic. Never claim the two SHAs are exactly the same commit.
- Treat the supplied hunks as the source of truth.
`;
};

export const buildWalkthroughPromptInput = (
  state: RepositoryState,
  options: WalkthroughPromptOptions = {},
) => {
  const index = indexWalkthroughHunks(state.files);
  const patchBudgets = getPromptPatchBudgets(state.files.length);
  const size = {
    fileCount: state.files.length,
    hunkCount: index.hunks.length,
  };
  let remainingPatchBudget = patchBudgets.total;
  const digest = {
    branch: state.branch,
    commitContext: options.commitContext ?? null,
    files: state.files.map((file) => ({
      ...(isGeneratedWalkthroughPath(file.path)
        ? {
            generated: true,
            generatedReason:
              'Generated-like file; Codiff exposes each changed section as one synthetic hunk.',
          }
        : {}),
      oldPath: file.oldPath,
      path: file.path,
      sections: file.sections.map((section) => {
        const patchExcerpt = buildPatchExcerpt(section, remainingPatchBudget, patchBudgets.section);
        remainingPatchBudget = Math.max(0, remainingPatchBudget - patchExcerpt.length);
        return {
          binary: section.binary,
          hunks: index.hunks
            .filter((hunk) => hunk.sectionId === section.id)
            .map((hunk) => buildPromptHunk(hunk, index.aliasByHunkId.get(hunk.id) ?? hunk.id)),
          id: section.id,
          kind: section.kind,
          loadState: section.loadState,
          patchExcerpt,
          summary: section.summary?.reason,
        };
      }),
      status: file.status,
    })),
    reviewStrategy: buildReviewStrategyDigest(options.reviewStrategy),
    source:
      (options.commitContext || options.versionCommitContext) &&
      state.source.type === 'pull-request'
        ? {
            ...state.source,
            description: undefined,
            title:
              options.commitContext?.subject ??
              options.versionCommitContext?.after?.subject ??
              options.versionCommitContext?.before?.subject ??
              state.source.title,
          }
        : state.source.type === 'pull-request' && typeof state.source.description === 'string'
          ? { ...state.source, description: truncate(state.source.description, maxProseChars) }
          : state.source,
    versionBaseContext: options.versionBaseContext ?? null,
    versionCommentReferences: (options.versionCommentReferences ?? []).map((comment) => ({
      ...comment,
      body: truncate(comment.body, 500),
    })),
    versionCommitContext: options.versionCommitContext ?? null,
    versionCompareRange: options.versionCompareRange ?? null,
  };
  return { digest, patchBudgets, size };
};

export const buildWalkthroughPrompt = (
  state: RepositoryState,
  options: WalkthroughPromptOptions = {},
) => {
  const { digest, size } = buildWalkthroughPromptInput(state, options);
  return `Author a Codiff narrative walkthrough for this GitLab merge request.

Use only the supplied digest. Return the required structured object. If source.description is present, treat it as author-written intent and orientation, not proof of behavior; patches and hunk data remain the source of truth.

${buildWalkthroughSizingGuidance(size, { independentCommit: Boolean(options.commitContext || options.versionCommitContext) })}

Product rules:
- Write all user-visible text in English.
- Order the review by conceptual leverage, not file path.
- Keep prose concise, concrete, and evidence-based. Inline code is allowed, but no headings or lists.
- Do not claim tests, risks, or behavior that the diff does not support.
${buildCommitStructureGuidance(options.reviewStrategy)}
${buildVersionCompareStructureGuidance(options.versionCompareRange)}
${buildVersionBaseGuidance(options.versionBaseContext)}
${buildSingleCommitGuidance(options.commitContext)}
${buildVersionCommitGuidance(options.versionCommitContext)}
${buildVersionCommentGuidance(options.versionCommentReferences)}

Repository digest:
${JSON.stringify(digest)}`;
};

/** @deprecated Prefer normalizeWalkthroughDraft. */
export const normalizeAuthoredWalkthrough = normalizeWalkthroughDraft;

export type UnitWalkthroughEntry = {
  context:
    | {
        commit: {
          sha: string;
          shortSha: string;
          subject: string;
          webUrl?: string;
        };
        kind: 'mr-commit';
      }
    | {
        after?: {
          sha: string;
          shortSha: string;
          subject: string;
          webUrl?: string;
        };
        before?: {
          sha: string;
          shortSha: string;
          subject: string;
          webUrl?: string;
        };
        commentReferences?: ReadonlyArray<WalkthroughCommentReference>;
        evolutionKind?: 'likely-revised' | 'added' | 'removed' | 'ambiguous';
        kind: 'version-commit';
        range: { fromLabel: string; toLabel: string };
        rebaseDrivers?: ReadonlyArray<{
          authoredAt?: string;
          authorName?: string;
          overlappingPaths?: ReadonlyArray<string>;
          sha?: string;
          shortSha: string;
          subject: string;
          webUrl?: string;
        }>;
        unitId: string;
      };
  state: RepositoryState;
  walkthrough: NarrativeWalkthrough | null;
};
const versionCommitOverviewKindLabel = (
  kind: Extract<UnitWalkthroughEntry['context'], { kind: 'version-commit' }>['evolutionKind'],
) => {
  switch (kind) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'likely-revised':
      return 'revised';
    default:
      return 'unclassified';
  }
};

const toVersionCommitKind = (
  kind: NonNullable<
    Extract<UnitWalkthroughEntry['context'], { kind: 'version-commit' }>['evolutionKind']
  >,
): VersionCommitKind =>
  kind === 'added' ? 'introduced' : kind === 'likely-revised' ? 'revised' : kind;

/** Build the focused cross-commit summary that appears above a unit walkthrough. */
export const buildVersionCommitOverviewPrompt = ({
  entries,
  range,
}: {
  entries: ReadonlyArray<UnitWalkthroughEntry>;
  range: { fromLabel: string; toLabel: string };
}) => {
  const commits = entries.flatMap((entry) => {
    if (entry.context.kind !== 'version-commit') {
      return [];
    }
    const { after, before, evolutionKind } = entry.context;
    return [
      {
        earlierCommit: before ? `${before.shortSha}: ${before.subject}` : null,
        kind: versionCommitOverviewKindLabel(evolutionKind),
        laterCommit: after ? `${after.shortSha}: ${after.subject}` : null,
        unitFocus: entry.walkthrough?.focus ?? null,
      },
    ];
  });
  return `Write the Review focus for a commit-by-commit version comparison from ${range.fromLabel} to ${range.toLabel}.

> Scope is strictly the changes since ${range.fromLabel}, through ${range.toLabel}. Frame every statement as a change that occurred after the earlier selected version. Do not summarize the merge request as a whole, describe behavior already present in ${range.fromLabel} as newly introduced, or infer changes outside this version window.

> The reviewer needs a concise, evidence-based overview of the various changed commits before following the detailed walkthrough. Synthesize the supplied unit summaries; do not merely count commits or repeat their subjects. Mention each commit's kind (added, removed, revised, or unclassified) when it clarifies what changed. Do not describe pure rebase noise as new behavior. Use 2-4 short sentences, no heading or list.

> Commit context (ordered):
${JSON.stringify(commits)}`;
};
/**
 * Deterministically compose completed unit walkthroughs into one narrative.
 */
export const composeUnitWalkthroughs = ({
  agent,
  entries,
  focus,
  state,
}: {
  agent: NarrativeWalkthrough['agent'];
  entries: ReadonlyArray<UnitWalkthroughEntry>;
  focus?: string;
  state: RepositoryState;
}): NarrativeWalkthrough => {
  const chapters = entries.flatMap((entry) => {
    const context = entry.context;
    const identity = context.kind === 'mr-commit' ? context.commit.sha : context.unitId;
    const summary =
      context.kind === 'mr-commit' ? context.commit : (context.after ?? context.before);
    const entryWalkthrough =
      context.kind === 'version-commit' && entry.walkthrough
        ? attachVersionCommentReferences(entry.walkthrough, context.commentReferences)
        : entry.walkthrough;
    const rebaseDrivers = context.kind === 'version-commit' ? (context.rebaseDrivers ?? []) : [];
    return (entryWalkthrough?.chapters ?? []).map((chapter, chapterIndex) => ({
      ...chapter,
      ...(chapterIndex === 0 && summary
        ? {
            commit: {
              gitSha: summary.sha,
              sha: identity,
              shortSha: summary.shortSha,
              subject: summary.subject,
              webUrl: summary.webUrl,
              ...(context.kind === 'version-commit' &&
              context.evolutionKind &&
              context.after?.sha === summary.sha
                ? { versionCommitKind: toVersionCommitKind(context.evolutionKind) }
                : {}),
              ...(rebaseDrivers.length > 0
                ? {
                    rebaseDrivers: rebaseDrivers.map((driver) => ({
                      authoredAt: driver.authoredAt,
                      authorName: driver.authorName,
                      overlappingPaths: driver.overlappingPaths,
                      sha: driver.sha,
                      shortSha: driver.shortSha,
                      subject: driver.subject,
                      webUrl: driver.webUrl,
                    })),
                  }
                : {}),
            },
          }
        : {}),
      id: `${identity}:${chapter.id}`,
      stops: chapter.stops.map((stop) => ({ ...stop, id: `${identity}:${stop.id}` })),
    }));
  });
  const versionContext = entries.find((entry) => entry.context.kind === 'version-commit')?.context;
  const isVersionComparison = versionContext?.kind === 'version-commit';
  return {
    agent,
    chapters,
    commitFiles: entries.flatMap((entry) => entry.state.files),
    focus: clean(
      focus ?? '',
      isVersionComparison
        ? `Review ${entries.length} changed commit units in stack order.`
        : `Review ${entries.length} commits in topological order, from oldest to newest.`,
    ),
    generatedAt: new Date().toISOString(),
    kind: 'narrative',
    repo: { branch: state.branch, root: state.root },
    source: state.source,
    support: [],
    title: isVersionComparison
      ? `Commit-by-commit changes from ${versionContext.range.fromLabel} to ${versionContext.range.toLabel}`
      : 'Commit walkthroughs',
    version: 4,
  };
};

/** @deprecated Prefer composeUnitWalkthroughs. */
export const combineCommitWalkthroughs = composeUnitWalkthroughs;
