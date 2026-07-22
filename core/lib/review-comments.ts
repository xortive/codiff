import type { CodeViewLineSelection } from '@pierre/diffs';
import type {
  ChangedFile,
  DiffSection,
  PullRequestReviewComment,
  RepositoryState,
} from '../types.ts';
import type { CodeViewInstance, ReviewComment } from './app-types.ts';
import { parseSectionDiffWithOptions } from './diff.ts';

export const isInteractiveReviewEvent = (event: PointerEvent) =>
  event.composedPath().some(
    (target) =>
      // oxlint-disable-next-line @nkzw/no-instanceof
      target instanceof HTMLElement &&
      (target.closest('button, textarea, input, select, a') ||
        target.closest('.review-comment-thread')),
  );

export const hasActiveTextSelection = () => {
  const selection = window.getSelection();
  return selection != null && selection.rangeCount > 0 && !selection.isCollapsed;
};

export const isFileReviewComment = (
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side'>,
) => comment.anchor === 'file' || comment.lineNumber == null || comment.side == null;

export const isLineReviewComment = (
  comment: ReviewComment,
): comment is ReviewComment & { lineNumber: number; side: 'additions' | 'deletions' } =>
  !isFileReviewComment(comment);

export const getReviewCommentLineSelection = (comment: ReviewComment): CodeViewLineSelection => ({
  id: `diff:${comment.sectionId}`,
  range: {
    end: comment.lineNumber ?? 1,
    ...(comment.startSide != null && comment.startSide !== comment.side
      ? { endSide: comment.side }
      : {}),
    side: comment.startSide ?? comment.side ?? 'additions',
    start: comment.startLineNumber ?? comment.lineNumber ?? 1,
  },
});

type ReviewPatchRow = {
  additionLineNumber?: number;
  deletionLineNumber?: number;
  patchLineIndex: number;
  patchLines: ReadonlyArray<string>;
  prefix: '+' | '-' | ' ';
  side?: ReviewComment['side'];
};

const matchesReviewPatchLine = (
  row: ReviewPatchRow,
  lineNumber: number,
  side: ReviewComment['side'],
) =>
  row.side
    ? row.side === side &&
      (side === 'additions'
        ? row.additionLineNumber === lineNumber
        : row.deletionLineNumber === lineNumber)
    : side === 'additions'
      ? row.additionLineNumber === lineNumber
      : row.deletionLineNumber === lineNumber;

export function updateStickyHeaderState(viewer: CodeViewInstance) {
  for (const item of viewer.getRenderedItems()) {
    const header = item.element.querySelector<HTMLElement>('.codiff-file-header');
    if (!header) {
      continue;
    }

    const headerTop = header.getBoundingClientRect().top;
    const itemTop = item.element.getBoundingClientRect().top;
    header.classList.toggle('stuck', headerTop > itemTop + 0.5);
  }
}

export const getReviewSideLabel = (side: ReviewComment['side']) =>
  side === 'additions' ? 'New' : 'Old';

export const getReviewCommentStartSide = (comment: Pick<ReviewComment, 'side' | 'startSide'>) =>
  comment.startSide ?? comment.side;

export const getReviewCommentLineLabel = (
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
  if (isFileReviewComment(comment)) {
    return 'File';
  }
  const startLineNumber = comment.startLineNumber;
  const startSide = getReviewCommentStartSide(comment);
  if (
    startLineNumber == null ||
    (startLineNumber === comment.lineNumber && startSide === comment.side)
  ) {
    return `${getReviewSideLabel(comment.side)} line ${comment.lineNumber}`;
  }

  if (startSide === comment.side) {
    return `${getReviewSideLabel(comment.side)} lines ${startLineNumber}-${comment.lineNumber}`;
  }

  return `${getReviewSideLabel(startSide)} line ${startLineNumber} to ${getReviewSideLabel(
    comment.side,
  )} line ${comment.lineNumber}`;
};

export const getReviewCommentRangeProps = (
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
) => {
  if (isFileReviewComment(comment)) {
    return { anchor: 'file' as const };
  }
  const startLineNumber = comment.startLineNumber;
  if (startLineNumber == null) {
    return {};
  }

  const startSide = getReviewCommentStartSide(comment);
  return startLineNumber !== comment.lineNumber || startSide !== comment.side
    ? {
        startLineNumber,
        ...(startSide !== comment.side ? { startSide } : {}),
      }
    : {};
};

export const toPullRequestReviewComment = (comment: ReviewComment): PullRequestReviewComment => ({
  body: comment.body,
  filePath: comment.filePath,
  ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
  ...(comment.side ? { side: comment.side } : {}),
  ...getReviewCommentRangeProps(comment),
  ...(comment.threadId ? { threadId: comment.threadId } : {}),
});

const isPendingPullRequestReviewComment = (comment: ReviewComment) =>
  !comment.isReadOnly &&
  !comment.threadId &&
  comment.remoteSubmit?.status !== 'submitting' &&
  comment.body.trim().length > 0;

export const getPendingPullRequestReviewComments = (
  comments: ReadonlyArray<ReviewComment>,
  activeDraft: Pick<ReviewComment, 'body' | 'id'> | null = null,
) => {
  return comments.flatMap((comment) => {
    const candidate =
      activeDraft?.id === comment.id ? { ...comment, body: activeDraft.body } : comment;
    return isPendingPullRequestReviewComment(candidate) ? [candidate] : [];
  });
};

export const findReusableReviewCommentDraft = (
  comments: ReadonlyArray<ReviewComment>,
  activeDraft: Pick<ReviewComment, 'body' | 'id'> | null = null,
) =>
  comments.find(
    (comment) =>
      !comment.isReadOnly &&
      comment.body.length === 0 &&
      !(activeDraft?.id === comment.id && activeDraft.body.trim().length > 0),
  );

export const getCommentKey = (
  comment: Pick<
    ReviewComment,
    'anchor' | 'lineNumber' | 'sectionId' | 'side' | 'startLineNumber' | 'startSide'
  >,
) =>
  isFileReviewComment(comment)
    ? `${comment.sectionId}:file`
    : `${comment.sectionId}:${comment.side}:${comment.lineNumber}:${
        comment.startLineNumber ?? comment.lineNumber
      }:${comment.startSide ?? comment.side}`;

const getCommentTextDigest = (value: string | null | undefined) =>
  value ? `${value.length},${value.split('\n').length}` : '0,0';

export const getReviewCommentsDigest = (comments: ReadonlyArray<ReviewComment>) =>
  comments
    .map(
      (comment) =>
        `${comment.id}:${comment.sectionId}:${comment.side}:${comment.lineNumber}:${
          comment.startLineNumber ?? ''
        }:${comment.startSide ?? ''}:${comment.anchor ?? ''}:${getCommentTextDigest(
          comment.body,
        )}:${comment.codexReply?.status ?? ''}:${getCommentTextDigest(
          comment.codexReply?.body,
        )}:${getCommentTextDigest(comment.codexReply?.error)}:${
          comment.remoteSubmit?.status ?? ''
        }:${comment.remoteSubmit?.error ?? ''}:${comment.threadId ?? ''}:${
          comment.canResolveThread === true ? '1' : '0'
        }:${comment.isThreadResolved === true ? '1' : '0'}`,
    )
    .join('\0');

const getMarkdownFence = (content: string) => {
  let fence = '```';
  while (content.includes(fence)) {
    fence += '`';
  }
  return fence;
};

const indentMarkdown = (value: string) =>
  value
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');

const formatReviewLineNumber = (lineNumber: number | string) => String(lineNumber).padStart(4);
// @pierre/diffs keeps source line terminators; copied Markdown rows add their own separators.
const trimReviewPatchLineTerminator = (line: string) =>
  line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line;

const getReviewPatchText = (lines: ReadonlyArray<string>, index: number) =>
  trimReviewPatchLineTerminator(lines[index] ?? '');

export const getReviewCommentPatchContext = (
  file: ChangedFile,
  section: DiffSection,
  comment: ReviewComment,
  showWhitespace: boolean,
) => {
  if (isFileReviewComment(comment)) {
    return section.summary?.reason || section.patch.trim() || 'No patch context available.';
  }
  const fileDiff = parseSectionDiffWithOptions(file, section, showWhitespace);

  for (const hunk of fileDiff.hunks) {
    const rows: Array<ReviewPatchRow> = [];
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            additionLineNumber: additionLineNumber + index,
            deletionLineNumber: deletionLineNumber + index,
            patchLineIndex: content.additionLineIndex + index,
            patchLines: fileDiff.additionLines,
            prefix: ' ',
          });
        }
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          deletionLineNumber: deletionLineNumber + index,
          patchLineIndex: content.deletionLineIndex + index,
          patchLines: fileDiff.deletionLines,
          prefix: '-',
          side: 'deletions',
        });
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          additionLineNumber: additionLineNumber + index,
          patchLineIndex: content.additionLineIndex + index,
          patchLines: fileDiff.additionLines,
          prefix: '+',
          side: 'additions',
        });
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    const side = comment.side ?? 'additions';
    const startLine = comment.startLineNumber ?? comment.lineNumber ?? 1;
    const startSide = getReviewCommentStartSide(comment) ?? side;
    const endLine = comment.lineNumber ?? 1;
    const targetIndex = rows.findIndex((row) => matchesReviewPatchLine(row, endLine, side));
    const rangeStartIndex = rows.findIndex((row) =>
      matchesReviewPatchLine(row, startLine, startSide),
    );

    if (targetIndex === -1) {
      continue;
    }

    const anchorStart = rangeStartIndex === -1 ? targetIndex : rangeStartIndex;
    const start = Math.max(0, Math.min(anchorStart, targetIndex) - 3);
    const end = Math.min(rows.length, Math.max(anchorStart, targetIndex) + 4);
    const context = rows.slice(start, end).map((row) => {
      const lineNumber =
        row.prefix === '+'
          ? row.additionLineNumber
          : row.prefix === '-'
            ? row.deletionLineNumber
            : `${row.deletionLineNumber ?? ''}/${row.additionLineNumber ?? ''}`;
      return `${row.prefix}${formatReviewLineNumber(lineNumber ?? '')} | ${getReviewPatchText(
        row.patchLines,
        row.patchLineIndex,
      )}`;
    });

    return [hunk.hunkSpecs?.trim(), ...context].filter(Boolean).join('\n');
  }

  return section.summary?.reason || section.patch.trim() || 'No patch context available.';
};

export const getReviewCommentSection = (
  file: ChangedFile,
  comment: Pick<ReviewComment, 'anchor' | 'lineNumber' | 'side' | 'startLineNumber' | 'startSide'>,
  showWhitespace: boolean,
) => {
  if (isFileReviewComment(comment)) {
    return file.sections[0];
  }
  const side = comment.side ?? 'additions';
  const line = comment.lineNumber ?? 1;
  const startLine = comment.startLineNumber ?? line;
  const startSide = comment.startSide ?? side;
  return (
    file.sections.find((section) => {
      const parsed = parseSectionDiffWithOptions(file, section, showWhitespace);
      return parsed.hunks.some((hunk) => {
        let oldLine = hunk.deletionStart;
        let newLine = hunk.additionStart;
        let hasStart = false;
        let hasEnd = false;
        for (const content of hunk.hunkContent) {
          if (content.type === 'context') {
            if (
              (startSide === 'additions' &&
                startLine >= newLine &&
                startLine < newLine + content.lines) ||
              (startSide === 'deletions' &&
                startLine >= oldLine &&
                startLine < oldLine + content.lines)
            ) {
              hasStart = true;
            }
            if (
              (side === 'additions' && line >= newLine && line < newLine + content.lines) ||
              (side === 'deletions' && line >= oldLine && line < oldLine + content.lines)
            ) {
              hasEnd = true;
            }
            oldLine += content.lines;
            newLine += content.lines;
            continue;
          }
          if (side === 'deletions' && line >= oldLine && line < oldLine + content.deletions) {
            hasEnd = true;
          }
          if (
            startSide === 'deletions' &&
            startLine >= oldLine &&
            startLine < oldLine + content.deletions
          ) {
            hasStart = true;
          }
          if (side === 'additions' && line >= newLine && line < newLine + content.additions) {
            hasEnd = true;
          }
          if (
            startSide === 'additions' &&
            startLine >= newLine &&
            startLine < newLine + content.additions
          ) {
            hasStart = true;
          }
          oldLine += content.deletions;
          newLine += content.additions;
        }
        return hasStart && hasEnd;
      });
    }) ?? file.sections[0]
  );
};

export const buildReviewCommentsMarkdown = (
  files: ReadonlyArray<ChangedFile>,
  comments: ReadonlyArray<ReviewComment>,
  showWhitespace: boolean,
  prefix?: string,
) => {
  const pendingComments = comments.filter((comment) => !comment.isReadOnly && comment.body.trim());
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedComments = pendingComments.sort((left, right) => {
    const leftFileIndex = files.findIndex((file) => file.path === left.filePath);
    const rightFileIndex = files.findIndex((file) => file.path === right.filePath);
    return (
      leftFileIndex - rightFileIndex ||
      (left.lineNumber ?? 0) - (right.lineNumber ?? 0) ||
      left.id.localeCompare(right.id)
    );
  });

  const markdown = orderedComments
    .map((comment, index) => {
      const file = filesByPath.get(comment.filePath);
      const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);
      const context =
        file && section
          ? getReviewCommentPatchContext(file, section, comment, showWhitespace)
          : 'No patch context available.';
      const fence = getMarkdownFence(context);

      return [
        `${index + 1}. **${comment.filePath}** (${getReviewCommentLineLabel(comment)})`,
        '',
        indentMarkdown(`${fence}diff\n${context}\n${fence}`),
        '',
        indentMarkdown(comment.body.trim()),
      ].join('\n');
    })
    .join('\n\n');

  const resolvedPrefix =
    prefix == null ? '# Address these Review Comments\n\n' : prefix ? `${prefix}\n\n` : '';
  return markdown ? `${resolvedPrefix}${markdown}` : '';
};

export const getReviewCommentsFromState = (state: RepositoryState): ReadonlyArray<ReviewComment> =>
  (state.reviewComments ?? []).flatMap((comment) => {
    const file = state.files.find((candidate) => candidate.path === comment.filePath);
    const section = file ? getReviewCommentSection(file, comment, false) : undefined;
    return section
      ? [
          {
            author: comment.author,
            body: comment.body,
            ...(comment.canDelete ? { canDelete: true } : {}),
            ...(comment.canEdit ? { canEdit: true } : {}),
            ...(comment.canReplyThread === false ? { canReplyThread: false } : {}),
            ...(comment.canResolveThread ? { canResolveThread: true } : {}),
            filePath: comment.filePath,
            id: comment.id,
            ...(comment.isOutdated ? { isOutdated: true } : {}),
            isReadOnly: true,
            ...(comment.isThreadResolved ? { isThreadResolved: true } : {}),
            ...(comment.anchor === 'file' ? { anchor: 'file' as const } : {}),
            ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
            sectionId: section.id,
            ...(comment.side ? { side: comment.side } : {}),
            ...getReviewCommentRangeProps(comment),
            submittedAt: comment.submittedAt,
            ...(comment.threadId ? { threadId: comment.threadId } : {}),
            url: comment.url,
          },
        ]
      : [];
  });

export const getVisibleReviewComments = (
  comments: ReadonlyArray<ReviewComment>,
  showOutdated: boolean,
): ReadonlyArray<ReviewComment> =>
  showOutdated ? comments : comments.filter((comment) => !comment.isOutdated);

export const shouldDiscardReviewCommentOnEscape = (
  body: string,
  confirmDiscard: (message: string) => boolean = window.confirm,
) => body.trim().length === 0 || confirmDiscard('Discard this review comment?');
