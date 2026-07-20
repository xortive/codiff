import { Select } from '@base-ui/react/select';
import { MarkdownEditor, type MarkdownEditorHandle } from '@nkzw/mdx-editor';
import useRelativeTime from '@nkzw/use-relative-time';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/ArrowSquareOut';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/ChatCircle';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/TreeStructure';
import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { ChevronDown, Trash2, X } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Avatar } from './app/components/Avatar.tsx';
import { Button } from './app/components/Button.tsx';
import { CommitRefTooltip, versionCommitKindLabel } from './app/components/CommitRefTooltip.tsx';
import { CommitScopePanel } from './app/components/CommitScopePanel.tsx';
import {
  isTerminalPullRequestMergeState,
  isPullRequestReviewActionDisabled,
  PullRequestMergeControls,
  PullRequestMergeStatusBadge,
  PullRequestReviewButtons,
} from './app/components/Panels.tsx';
import { ReadOnlyMarkdownView } from './app/components/ReadOnlyMarkdownView.tsx';
import {
  PullRequestSourceDescription,
  ReviewCodeView,
  type ReviewDiffBlock,
} from './app/components/ReviewCodeView.tsx';
import { ReviewTopBar, type ReviewModeItem } from './app/components/ReviewTopBar.tsx';
import { DiffLineCountBadge } from './app/components/Sidebar.tsx';
import { NarrativeSidebar } from './app/components/walkthrough/NarrativeSidebar.tsx';
import {
  NarrativeWalkthroughView,
  type WalkthroughBlockScrollTarget,
} from './app/components/walkthrough/NarrativeWalkthroughView.tsx';
import { useNarrativeNavigation } from './app/components/walkthrough/useNarrativeNavigation.ts';
import { WalkthroughProgress } from './app/components/walkthrough/WalkthroughProgress.tsx';
import { createDefaultConfig } from './config/defaults.ts';
import { matchesShortcut } from './config/keymap.ts';
import type { CodiffKeymap } from './config/types.ts';
import { getAgentLabel } from './lib/app-constants.ts';
import type {
  CodeViewInstance,
  ReviewComment,
  ReviewIdentity,
  ReviewScrollTarget,
} from './lib/app-types.ts';
import { DEFAULT_PADDING } from './lib/code-view-options.ts';
import {
  fileHasVisibleDiff,
  formatTreeLineCount,
  getDiffLineCount,
  getDiffLineCountTitle,
  getFirstVisibleSection,
  getItemId,
  getTotalDiffLineCount,
  isMarkdownFilePath,
} from './lib/diff.ts';
import { compactPath, fileTreeSort, fuzzyMatches, sortFiles, statusForTree } from './lib/files.ts';
import { isNativeInputTarget } from './lib/keyboard.ts';
import { isGeneratedWalkthroughFile } from './lib/narrative-walkthrough-diff.js';
import {
  combineWalkthroughCommitFiles,
  getWalkthroughCommitDiffShas,
} from './lib/narrative-walkthrough.ts';
import {
  getCommentKey,
  getPendingPullRequestReviewComments,
  getReviewCommentsFromState,
  toPullRequestReviewComment,
} from './lib/review-comments.ts';
import {
  evolutionUnitCommit,
  evolutionUnitRebaseDrivers,
  versionOptionHeadCommitId,
  versionOptionLabelText,
} from './lib/review-history.ts';
import {
  updateReviewIdentityCollapsed,
  updateReviewIdentityViewed,
} from './lib/review-identity.ts';
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from './lib/sidebar-width.ts';
import { getShortRef, getSourceLabel, getSourceKey } from './lib/source.ts';
import type {
  ChangedFile,
  CodiffPreferences,
  DiffComparisonAnalysis,
  DiffComparisonBaseMovement,
  DiffComparisonCommentAssociation,
  DiffComparisonView,
  GitIdentity,
  NarrativeWalkthrough,
  PullRequestAIReview,
  PullRequestMergeOptions,
  PullRequestGeneralComment,
  PullRequestGeneralCommentThread,
  PullRequestExistingReviewComment,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  ReviewAuthor,
  ReviewCommitEvolution,
  ReviewCommitListEntry,
  ReviewCommitSummary,
  ReviewEvolutionUnit,
  ReviewRebaseDriverCommit,
  ReviewStrategySummary,
  ReviewVersionOption,
  RepositoryState,
  SharedWalkthroughSnapshot,
  WalkthroughGenerationProgress,
  WalkthroughCommitMessageResult,
  WalkthroughCommitResult,
} from './types.ts';

const emptyReviewComments: ReadonlyArray<ReviewComment> = [];
const emptyExistingReviewComments: ReadonlyArray<PullRequestExistingReviewComment> = [];
const emptyGeneralCommentThreads: ReadonlyArray<PullRequestGeneralCommentThread> = [];
const emptyPaths = new Set<string>();
const emptyWalkthroughNotes = new Map();
const showResolvedCommentsStorageKey = 'codiff:web-show-resolved-comments:v1';
const walkthroughCodeViewBottomInset = 96;
const CODE_FONT_SIZE_DEFAULT = 13;
const defaultSharedPreferences: SharedWalkthroughSnapshot['preferences'] = {
  codeFontFamily: 'Fira Code',
  codeFontSize: CODE_FONT_SIZE_DEFAULT,
  diffStyle: 'split',
  showWhitespace: false,
  theme: 'system',
  wordWrap: false,
};

const readSharedSidebarWidth = () =>
  typeof localStorage === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : readSidebarWidth();

const writeSharedSidebarWidth = (width: number) => {
  if (typeof localStorage !== 'undefined') {
    writeSidebarWidth(width);
  }
};

export type MergeRequestWalkthroughStatus = 'failed' | 'generating' | 'idle' | 'ready';
export type MergeRequestReviewMode = 'comments' | 'commits' | 'tree' | 'walkthrough';
export type ReviewWalkthroughStatus = MergeRequestWalkthroughStatus;
export type ReviewMode = MergeRequestReviewMode;

// Optional host-supplied commit / version comparison surfaces for MR review.
// Hosts project provider history into Core contracts from `./types.ts`.
export type MergeRequestCommitListEntry = ReviewCommitListEntry;
export type MergeRequestReviewStrategySummary = ReviewStrategySummary;
export type MergeRequestVersionOption = ReviewVersionOption;
export type MergeRequestVersionCompareSummary = DiffComparisonAnalysis['summary'];
export type MergeRequestVersionCompareCommentAssociation = DiffComparisonCommentAssociation;
export type MergeRequestVersionBaseMovementCommit = NonNullable<
  DiffComparisonBaseMovement['commits']
>[number];
export type MergeRequestVersionBaseMovement = DiffComparisonBaseMovement;
export type MergeRequestVersionCommitSummary = ReviewCommitSummary;
export type MergeRequestVersionRebaseDriverCommit = ReviewRebaseDriverCommit;
export type MergeRequestVersionCommitEvolutionUnit = ReviewEvolutionUnit;
export type MergeRequestVersionCommitEvolution = ReviewCommitEvolution;
export type MergeRequestVersionCompareView = DiffComparisonView;

const versionOptionLabel = versionOptionLabelText;
const versionOptionHeadSha = versionOptionHeadCommitId;

const versionOptionHeadUrl = (version: ReviewVersionOption, projectUrl?: string) =>
  version.range.head.label.url ??
  (projectUrl
    ? `${projectUrl}/-/commit/${encodeURIComponent(version.range.head.commitId)}`
    : undefined);

export type SharedWalkthroughCommenting = {
  canComment: boolean;
  onDeleteComment: (commentId: string) => Promise<void>;
  onDeleteGeneralComment: (commentId: string) => Promise<void>;
  onReplyGeneralComment: (threadId: string, body: string) => Promise<void>;
  onResolveDiscussion: (discussionId: string, resolved: boolean) => Promise<void>;
  onSignIn: () => Promise<void> | void;
  onSubmitComment: (comment: PullRequestReviewComment) => Promise<PullRequestExistingReviewComment>;
  onSubmitGeneralComment: (body: string) => Promise<void>;
  onUpdateComment: (commentId: string, body: string) => Promise<void>;
  onUpdateGeneralComment: (commentId: string, body: string) => Promise<void>;
};
export type ReviewCommenting = SharedWalkthroughCommenting;

export type MergeRequestReviewAppProps = {
  aiReviews?: ReadonlyArray<PullRequestAIReview>;
  commentsError?: string | null;
  commentsLoading?: boolean;
  commits?: ReadonlyArray<MergeRequestCommitListEntry>;
  externalUrl: string;
  gitIdentity?: GitIdentity | null;
  initialMode?: MergeRequestReviewMode;
  onCancelAutoMerge?: () => Promise<void> | void;
  onClosePullRequest?: () => Promise<void> | void;
  onExitVersionCompare?: () => void;
  onGenerateWalkthrough: (options?: {
    force?: boolean;
    reviewStructure?: 'commit-by-commit' | 'whole-diff';
    unitId?: string;
    versionCompare?: {
      fromId: string;
      toId: string;
      walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
    };
  }) => Promise<void> | void;
  onHome: () => void;
  onLoadCommitDiff?: (
    sha: string,
  ) => Promise<ReadonlyArray<ChangedFile>> | ReadonlyArray<ChangedFile>;
  onLoadVersionCommitDiff?: (
    unitId: string,
  ) => Promise<ReadonlyArray<ChangedFile>> | ReadonlyArray<ChangedFile>;
  onMergePullRequest?: (
    options: PullRequestMergeOptions & { autoMerge: boolean },
  ) => Promise<void> | void;
  onModeChange?: (mode: MergeRequestReviewMode) => void;
  onOpenVersionCompare?: (options?: { commentId?: string }) => void;
  onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
  onSubmitComment: (comment: PullRequestReviewComment) => Promise<PullRequestExistingReviewComment>;
  onSubmitGeneralComment: (body: string) => Promise<void>;
  onSubmitReview: (
    event: PullRequestReviewEvent,
    comments: ReadonlyArray<PullRequestReviewComment>,
    body?: string,
  ) => Promise<void>;
  onUpdateComment: (commentId: string, body: string) => Promise<void>;
  onUpdateDescription?: (body: string) => Promise<void> | void;
  onUpdateGeneralComment: (commentId: string, body: string) => Promise<void>;
  onUpdateTitle?: (title: string) => Promise<void> | void;
  onUploadDescriptionAsset?: (file: File) => Promise<string> | string;
  onVersionCompareRangeChange?: (fromId: string, toId: string) => void;
  onVersionWalkthroughStructureChange?: (structure: 'commit-by-commit' | 'whole-diff') => void;
  preferences?: Partial<
    Pick<
      CodiffPreferences,
      'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
    >
  >;
  /** Shown in external-link tooltips (for example GitLab or GitHub). */
  providerLabel?: string;
  reviewStrategy?: MergeRequestReviewStrategySummary | null;
  selectedCommitSha?: string | null;
  settingsBar?: ReactNode;
  sourceDescriptionFooterAside?: ReactNode;
  state: RepositoryState;
  title: string;
  versionCommitEvolution?: MergeRequestVersionCommitEvolution | null;
  versionCommitEvolutionError?: string | null;
  versionCommitEvolutionLoading?: boolean;
  versionCompare?: MergeRequestVersionCompareView | null;
  versionCompareEnabled?: boolean;
  versionCompareError?: string | null;
  versionCompareFromId?: string | null;
  versionCompareLoading?: boolean;
  versionCompareToId?: string | null;
  /** Sidebar history section title. GitLab: Versions; GitHub: Head history. */
  versionHistoryLabel?: string;
  versionHistoryLoading?: boolean;
  versionHistoryWarning?: string | null;
  versions?: ReadonlyArray<MergeRequestVersionOption>;
  versionWalkthroughStructure?: 'commit-by-commit' | 'whole-diff';
  walkthrough: NarrativeWalkthrough | null;
  walkthroughError?: string | null;
  walkthroughProgress?: WalkthroughGenerationProgress | null;
  walkthroughStatus: MergeRequestWalkthroughStatus;
  /** Baseline scope label. GitLab: Whole MR; GitHub: Whole PR. */
  wholeDiffLabel?: string;
};

const getCodeFontLineHeight = (size: number) => Math.round((size * 20) / 13);

const normalizeCodeFontSizePreference = (size: number) =>
  Number.isFinite(size) ? Math.min(32, Math.max(10, Math.round(size))) : CODE_FONT_SIZE_DEFAULT;

const getSnapshotReviewComments = (
  snapshot: SharedWalkthroughSnapshot,
): ReadonlyArray<ReviewComment> => {
  if (!snapshot.reviewComments?.length) {
    return emptyReviewComments;
  }

  return getReviewCommentsFromState({
    branch: snapshot.branch,
    files: snapshot.files,
    generatedAt: Date.parse(snapshot.exportedAt) || Date.now(),
    launchPath: snapshot.repository.root,
    reviewComments: snapshot.reviewComments as ReadonlyArray<PullRequestExistingReviewComment>,
    root: snapshot.repository.root,
    source: snapshot.repository.source,
  } satisfies RepositoryState);
};

const noop = () => {};

const getAuthorDisplayName = (author: ReviewAuthor) => author.name || author.login;
const getGeneralCommentElementId = (commentId: string) => `general-comment:${commentId}`;

const scrollCommentIntoContainerView = (container: HTMLElement, element: HTMLElement) => {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const top =
    container.scrollTop +
    elementRect.top -
    containerRect.top -
    Math.max(0, (container.clientHeight - elementRect.height) / 2);

  container.scrollTo({
    behavior: 'smooth',
    top,
  });
};
const plainTextCommentPattern =
  /<!--[\s\S]*?-->|<\/?(?:details|summary)\b[^>]*>|```[\s\S]*?```|`([^`]+)`|\[([^\]]+)\]\([^)]+\)|[*_~>#]+/g;

const getCommentPreview = (body: string) => {
  const preview = body
    .replaceAll(
      plainTextCommentPattern,
      (_, inlineCode: string | undefined, linkText: string | undefined) =>
        inlineCode ?? linkText ?? ' ',
    )
    .replaceAll(/\s+/g, ' ')
    .trim();
  return preview || 'Comment';
};

const getAIReviewDecisionLabel = (decision: PullRequestAIReview['decision']) => {
  switch (decision) {
    case 'approved':
      return 'Approved';
    case 'approved-with-comments':
      return 'Approved with comments';
    case 'changes-requested':
      return 'Changes requested';
    default:
      return 'Decision unavailable';
  }
};

const formatSubmittedAt = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
};

function RelativeSubmittedAtTime({
  submittedAt,
  timestamp,
}: {
  submittedAt: string;
  timestamp: number;
}) {
  const relativeTime = useRelativeTime(timestamp);
  return (
    <time dateTime={submittedAt} title={formatSubmittedAt(submittedAt)}>
      {relativeTime}
    </time>
  );
}

function SubmittedAtTime({ submittedAt }: { submittedAt: string }) {
  const timestamp = Date.parse(submittedAt);
  if (!Number.isFinite(timestamp)) {
    return (
      <time dateTime={submittedAt} title={submittedAt}>
        {submittedAt}
      </time>
    );
  }
  return <RelativeSubmittedAtTime submittedAt={submittedAt} timestamp={timestamp} />;
}

export function ReadOnlyGeneralCommentCard({
  className = '',
  comment,
  focused = false,
}: {
  className?: string;
  comment: PullRequestGeneralComment;
  focused?: boolean;
}) {
  const displayName = getAuthorDisplayName(comment.author);
  const classes = ['review-comment', 'general-comment-card', focused ? 'focused' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} id={getGeneralCommentElementId(comment.id)}>
      <Avatar name={displayName} size="medium" url={comment.author.avatarUrl} />
      <div className="review-comment-body source-description-body">
        <div className="review-comment-header read-only general-comment-header">
          <strong title={`@${comment.author.login}`}>{displayName}</strong>
          {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
        </div>
        <ReadOnlyMarkdownView
          ariaLabel={`Comment by ${displayName}`}
          className="review-comment-markdown-editor general-comment-markdown-editor"
          contentClassName="review-comment-input read-only general-comment-input"
          fallback={<div className="review-comment-input read-only" />}
          value={comment.body}
          variant="embedded"
        />
      </div>
    </article>
  );
}

function GeneralCommentCard({
  comment,
  editDraft,
  editError,
  editing,
  editSubmitting,
  focused,
  keymap,
  onCancelEdit,
  onChangeEditDraft,
  onDelete,
  onSaveEdit,
  onStartEdit,
}: {
  comment: PullRequestGeneralComment;
  editDraft: string;
  editError: string | null;
  editing: boolean;
  editSubmitting: boolean;
  focused: boolean;
  keymap: CodiffKeymap;
  onCancelEdit: () => void;
  onChangeEditDraft: (draft: string) => void;
  onDelete: (commentId: string) => void;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
}) {
  const displayName = getAuthorDisplayName(comment.author);
  const canSaveEdit = editing && !editSubmitting && Boolean(editDraft.trim());
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const handleEditKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!matchesShortcut(event, keymap, 'submitComment') || !canSaveEdit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onSaveEdit();
    },
    [canSaveEdit, keymap, onSaveEdit],
  );
  const setEditorRef = useCallback(
    (editor: MarkdownEditorHandle | null) => {
      editorRef.current = editor;
      if (editor && editing) {
        requestAnimationFrame(() => {
          editor.focus({ defaultSelection: 'rootEnd', preventScroll: true });
        });
      }
    },
    [editing],
  );

  useEffect(() => {
    if (!editing) {
      return;
    }

    requestAnimationFrame(() => {
      editorRef.current?.focus({ defaultSelection: 'rootEnd', preventScroll: true });
    });
  }, [editing]);

  return (
    <article
      className={`review-comment general-comment-card${focused ? ' focused' : ''}`}
      id={getGeneralCommentElementId(comment.id)}
    >
      <Avatar name={displayName} size="medium" url={comment.author.avatarUrl} />
      <div className="review-comment-body source-description-body">
        <div
          className={`review-comment-header read-only general-comment-header${
            comment.canEdit || comment.canDelete || editing ? ' with-comment-action' : ''
          }`}
        >
          <strong title={`@${comment.author.login}`}>{displayName}</strong>
          {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
          {editing ? (
            <span className="general-comment-edit-actions">
              <button
                className="review-comment-action"
                disabled={editSubmitting}
                onClick={onCancelEdit}
                type="button"
              >
                Cancel
              </button>
              <button
                className="review-comment-action"
                disabled={!canSaveEdit}
                onClick={onSaveEdit}
                type="button"
              >
                {editSubmitting ? 'Saving' : 'Save'}
              </button>
            </span>
          ) : (
            <>
              {comment.canEdit ? (
                <button
                  className="review-comment-action"
                  onClick={() => onStartEdit(comment)}
                  type="button"
                >
                  Edit
                </button>
              ) : null}
              {comment.canDelete ? (
                <button
                  aria-label="Delete comment"
                  className="review-comment-delete"
                  onClick={() => onDelete(comment.id)}
                  title="Delete comment"
                  type="button"
                >
                  <X aria-hidden className="review-comment-delete-icon" size={14} />
                </button>
              ) : null}
            </>
          )}
        </div>
        {editing ? (
          <>
            <Suspense fallback={<div className="review-comment-input" />}>
              <MarkdownEditor
                ariaLabel={`Edit comment by ${displayName}`}
                className="review-comment-markdown-editor general-comment-markdown-editor"
                colorScheme="inherit"
                contentClassName="review-comment-input general-comment-input"
                density="compact"
                onChange={onChangeEditDraft}
                onKeyDown={handleEditKeyDown}
                readOnly={editSubmitting}
                ref={setEditorRef}
                spellCheck
                value={editDraft}
                variant="embedded"
              />
            </Suspense>
            {editError ? <div className="review-comment-error">{editError}</div> : null}
          </>
        ) : (
          <ReadOnlyMarkdownView
            ariaLabel={`Comment by ${displayName}`}
            className="review-comment-markdown-editor general-comment-markdown-editor"
            contentClassName="review-comment-input read-only general-comment-input"
            fallback={<div className="review-comment-input read-only" />}
            value={comment.body}
            variant="embedded"
          />
        )}
      </div>
    </article>
  );
}

function GeneralCommentThreadCard({
  canComment,
  editDraft,
  editError,
  editingCommentId,
  editSubmitting,
  focusedCommentId,
  keymap,
  onCancelEdit,
  onChangeEditDraft,
  onDelete,
  onReply,
  onResolve,
  onSaveEdit,
  onStartEdit,
  thread,
}: {
  canComment: boolean;
  editDraft: string;
  editError: string | null;
  editingCommentId: string | null;
  editSubmitting: boolean;
  focusedCommentId: string | null;
  keymap: CodiffKeymap;
  onCancelEdit: () => void;
  onChangeEditDraft: (draft: string) => void;
  onDelete: (commentId: string) => void;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
  thread: PullRequestGeneralCommentThread;
}) {
  const [replyDraft, setReplyDraft] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolved = thread.isResolved === true;
  const submitReply = useCallback(() => {
    const body = replyDraft.trim();
    if (!body || replying) {
      return;
    }
    setReplyError(null);
    setReplying(true);
    void onReply(thread.id, body)
      .then(() => {
        setReplyDraft('');
        setShowReply(false);
      })
      .catch((error: unknown) => {
        setReplyError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setReplying(false));
  }, [onReply, replyDraft, replying, thread.id]);
  const toggleResolved = useCallback(() => {
    if (resolving) {
      return;
    }
    setResolving(true);
    void onResolve(thread.id, !resolved)
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setResolving(false));
  }, [onResolve, resolved, resolving, thread.id]);

  return (
    <section className="general-comment-thread">
      {thread.comments.map((comment) => (
        <GeneralCommentCard
          comment={comment}
          editDraft={editDraft}
          editError={editingCommentId === comment.id ? editError : null}
          editing={editingCommentId === comment.id}
          editSubmitting={editSubmitting && editingCommentId === comment.id}
          focused={comment.id === focusedCommentId}
          key={comment.id}
          keymap={keymap}
          onCancelEdit={onCancelEdit}
          onChangeEditDraft={onChangeEditDraft}
          onDelete={onDelete}
          onSaveEdit={onSaveEdit}
          onStartEdit={onStartEdit}
        />
      ))}
      {thread.canReply && canComment && !resolved ? (
        showReply ? (
          <GeneralCommentComposer
            disabled={false}
            draft={replyDraft}
            error={replyError}
            gitIdentity={null}
            keymap={keymap}
            onChangeDraft={setReplyDraft}
            onSubmit={submitReply}
            submitting={replying}
          />
        ) : (
          <div className="review-comment-thread-footer">
            <button
              className="review-comment-action"
              onClick={() => setShowReply(true)}
              type="button"
            >
              Reply
            </button>
          </div>
        )
      ) : null}
      {thread.canResolve ? (
        <div className="review-comment-thread-footer">
          <button
            className="review-comment-action"
            disabled={resolving}
            onClick={toggleResolved}
            type="button"
          >
            {resolving ? 'Saving' : resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type SidebarOverviewComment = {
  canResolve: boolean;
  comment: PullRequestGeneralComment;
  isResolved: boolean;
};

function SidebarCommentSection({
  children,
  count,
  title,
}: {
  children: ReactNode;
  count: number;
  title: string;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="sidebar-comment-section">
      <button
        aria-expanded={expanded}
        className="sidebar-comment-section-toggle"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span>
          <strong>{title}</strong>
          <small>{count}</small>
        </span>
        <ChevronDown aria-hidden className={expanded ? '' : 'collapsed'} size={14} />
      </button>
      {expanded ? <div className="sidebar-comment-section-body">{children}</div> : null}
    </section>
  );
}

function SidebarOverviewCommentList({
  comments,
  focusedCommentId,
  onActivateComment,
}: {
  comments: ReadonlyArray<SidebarOverviewComment>;
  focusedCommentId: string | null;
  onActivateComment: (commentId: string) => void;
}) {
  return (
    <div className="history-list sidebar-comment-list">
      {comments.map(({ canResolve, comment, isResolved }, index) => {
        const displayName = getAuthorDisplayName(comment.author);
        const selected = comment.id === focusedCommentId;
        return (
          <button
            aria-current={selected ? 'true' : undefined}
            className={`history-entry sidebar-comment-entry with-metadata${selected ? ' selected' : ''}`}
            key={comment.id}
            onClick={() => onActivateComment(comment.id)}
            title={comment.body}
            type="button"
          >
            <span className="history-entry-ref">#{index + 1}</span>
            <span className="history-entry-subject">{getCommentPreview(comment.body)}</span>
            <span className="history-entry-meta">
              <span className="history-entry-author">
                <Avatar name={displayName} size="small" url={comment.author.avatarUrl} />
                <span>{displayName}</span>
              </span>
              {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
              <span>Overview</span>
              {canResolve ? <span>{isResolved ? 'Resolved' : 'Open'}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SidebarCodeCommentList({
  commentAssociations,
  comments,
  focusedCommentId,
  onActivateComment,
  onOpenVersionCompareForComment,
}: {
  commentAssociations: ReadonlyMap<string, DiffComparisonCommentAssociation>;
  comments: ReadonlyArray<PullRequestExistingReviewComment>;
  focusedCommentId: string | null;
  onActivateComment: (commentId: string) => void;
  onOpenVersionCompareForComment?: (commentId: string) => void;
}) {
  if (comments.length === 0) {
    return <div className="sidebar-comments-empty">No code comments.</div>;
  }
  return (
    <div className="history-list sidebar-comment-list">
      {comments.map((comment, index) => {
        const association = commentAssociations.get(comment.id);
        const versionLabel = comment.versionLabel;
        return (
          <button
            aria-current={comment.id === focusedCommentId ? 'true' : undefined}
            className={`history-entry sidebar-comment-entry with-metadata${
              comment.id === focusedCommentId ? ' selected' : ''
            }`}
            key={comment.id}
            onClick={() => onActivateComment(comment.id)}
            title={comment.body}
            type="button"
          >
            <span className="history-entry-ref">Code {index + 1}</span>
            <span className="history-entry-subject">{getCommentPreview(comment.body)}</span>
            <span className="history-entry-meta">
              <span>{comment.filePath}</span>
              {comment.submittedAt ? <SubmittedAtTime submittedAt={comment.submittedAt} /> : null}
              {comment.canResolveThread || comment.isThreadResolved ? (
                <span>{comment.isThreadResolved ? 'Resolved' : 'Open'}</span>
              ) : null}
              {comment.isOutdated ? (
                <span>{versionLabel ? `Outdated · ${versionLabel}` : 'Outdated'}</span>
              ) : versionLabel ? (
                <span>{versionLabel}</span>
              ) : null}
              {association && association.status !== 'still-valid' ? (
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenVersionCompareForComment?.(comment.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenVersionCompareForComment?.(comment.id);
                    }
                  }}
                  role="link"
                  tabIndex={0}
                  title="Open version comparison for this comment"
                >
                  {association.status === 'resolved-by-change'
                    ? 'Addressed by change'
                    : association.status === 'outdated'
                      ? 'Changed since comment'
                      : 'Version comparison'}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AIReviewDrawer({
  commentsError,
  commentsLoading,
  onSelectReview,
  reviews,
  selectedReviewId,
}: {
  commentsError: string | null;
  commentsLoading: boolean;
  onSelectReview: (reviewId: string) => void;
  reviews: ReadonlyArray<PullRequestAIReview>;
  selectedReviewId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const orderedReviews = reviews.toSorted(
    (first, second) => Date.parse(second.submittedAt ?? '') - Date.parse(first.submittedAt ?? ''),
  );
  const latest = orderedReviews[0];

  return (
    <section className="ai-review-drawer">
      <button
        aria-expanded={expanded}
        className="ai-review-drawer-toggle"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span>
          <strong>AI review</strong>
          <small>
            {commentsLoading ? (
              'Loading comments…'
            ) : latest ? (
              <>
                {getAIReviewDecisionLabel(latest.decision)} ·{' '}
                {latest.versionLabel ?? latest.reviewedHeadSha?.slice(0, 7) ?? 'unknown version'}
                {latest.submittedAt ? (
                  <>
                    {' '}
                    · <SubmittedAtTime submittedAt={latest.submittedAt} />
                  </>
                ) : null}
              </>
            ) : (
              'No configured AI review'
            )}
          </small>
        </span>
        <span aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="ai-review-drawer-body">
          {commentsError ? <div className="sidebar-scope-status error">{commentsError}</div> : null}
          {reviews.length === 0 && !commentsLoading ? (
            <span>No AI review records.</span>
          ) : (
            <div className="history-list ai-review-list">
              {orderedReviews.map((review, index) => (
                <button
                  aria-current={review.id === selectedReviewId ? 'true' : undefined}
                  className={`history-entry sidebar-comment-entry with-metadata${
                    review.id === selectedReviewId ? ' selected' : ''
                  }`}
                  key={review.id}
                  onClick={() => onSelectReview(review.id)}
                  title={review.body}
                  type="button"
                >
                  <span className="history-entry-ref">AI {index + 1}</span>
                  <span className="history-entry-subject">{getCommentPreview(review.body)}</span>
                  <span className="history-entry-meta">
                    <span>{getAIReviewDecisionLabel(review.decision)}</span>
                    <span>
                      {review.versionLabel ??
                        review.reviewedHeadSha?.slice(0, 7) ??
                        'Unknown version'}
                    </span>
                    {review.submittedAt ? (
                      <SubmittedAtTime submittedAt={review.submittedAt} />
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function GeneralCommentComposer({
  disabled,
  draft,
  error,
  gitIdentity,
  keymap,
  onChangeDraft,
  onSubmit,
  submitting,
}: {
  disabled: boolean;
  draft: string;
  error: string | null;
  gitIdentity: GitIdentity | null;
  keymap: CodiffKeymap;
  onChangeDraft: (draft: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const canSubmit = !disabled && !submitting && Boolean(draft.trim());
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!matchesShortcut(event, keymap, 'submitComment') || !canSubmit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onSubmit();
    },
    [canSubmit, keymap, onSubmit],
  );
  return (
    <section className="review-comment-thread general-comment-composer">
      <div className="review-comment">
        <Avatar
          name={gitIdentity?.name || gitIdentity?.email || 'You'}
          size="medium"
          url={gitIdentity?.gravatarUrl}
        />
        <div className="review-comment-body">
          <div className="review-comment-header general-comment-header general-comment-composer-header">
            <strong>{gitIdentity?.name || gitIdentity?.email || 'You'}</strong>
            <button
              className="review-comment-action"
              disabled={!canSubmit}
              onClick={onSubmit}
              title={canSubmit ? 'Submit comment' : 'Write a comment before commenting'}
              type="button"
            >
              <ChatCircle aria-hidden className="review-comment-action-icon" size={14} />
              {submitting ? 'Sending' : 'Comment'}
            </button>
          </div>
          <Suspense fallback={<div className="review-comment-input" />}>
            <MarkdownEditor
              ariaLabel="Add comment"
              className="review-comment-markdown-editor"
              colorScheme="inherit"
              contentClassName="review-comment-input"
              density="compact"
              onChange={onChangeDraft}
              onKeyDown={handleKeyDown}
              placeholder="Write a comment…"
              readOnly={disabled || submitting}
              spellCheck
              value={draft}
              variant="embedded"
            />
          </Suspense>
          {error ? <div className="review-comment-error">{error}</div> : null}
        </div>
      </div>
    </section>
  );
}

function AIReviewCommentCard({ review }: { review: PullRequestAIReview }) {
  const reviewerName = getAuthorDisplayName(review.reviewer);
  return (
    <article className="review-comment general-comment-card ai-review-comment-card">
      <Avatar name={reviewerName} size="medium" url={review.reviewer.avatarUrl} />
      <div className="review-comment-body source-description-body">
        <div className="review-comment-header read-only general-comment-header">
          <strong title={`@${review.reviewer.login}`}>{reviewerName}</strong>
          <span>
            {getAIReviewDecisionLabel(review.decision)}
            {' · '}
            {review.versionLabel ?? review.reviewedHeadSha?.slice(0, 7) ?? 'Unknown version'}
          </span>
          {review.submittedAt ? <SubmittedAtTime submittedAt={review.submittedAt} /> : null}
        </div>
        <ReadOnlyMarkdownView
          ariaLabel={`AI review by ${reviewerName}`}
          className="review-comment-markdown-editor general-comment-markdown-editor"
          contentClassName="review-comment-input read-only general-comment-input"
          fallback={<div className="review-comment-input read-only" />}
          value={review.body}
          variant="embedded"
        />
      </div>
    </article>
  );
}

function MergeRequestCommentsView({
  aiReview,
  canComment,
  commenting,
  commentsError,
  commentsLoading,
  draft,
  editDraft,
  editError,
  editingCommentId,
  editSubmitting,
  error,
  focusedCommentId,
  focusedCommentRequest,
  gitIdentity,
  keymap,
  onCancelEdit,
  onChangeDraft,
  onChangeEditDraft,
  onSaveEdit,
  onStartEdit,
  onSubmit,
  sourceDescription,
  submitting,
  threads,
}: {
  aiReview: PullRequestAIReview | null;
  canComment: boolean;
  commenting?: SharedWalkthroughCommenting;
  commentsError: string | null;
  commentsLoading: boolean;
  draft: string;
  editDraft: string;
  editError: string | null;
  editingCommentId: string | null;
  editSubmitting: boolean;
  error: string | null;
  focusedCommentId: string | null;
  focusedCommentRequest: number;
  gitIdentity: GitIdentity | null;
  keymap: CodiffKeymap;
  onCancelEdit: () => void;
  onChangeDraft: (draft: string) => void;
  onChangeEditDraft: (draft: string) => void;
  onSaveEdit: () => void;
  onStartEdit: (comment: PullRequestGeneralComment) => void;
  onSubmit: () => void;
  sourceDescription?: ReactNode;
  submitting: boolean;
  threads: ReadonlyArray<PullRequestGeneralCommentThread>;
}) {
  const commentsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusedCommentId == null) {
      return;
    }

    const container = commentsRef.current;
    const element = document.getElementById(getGeneralCommentElementId(focusedCommentId));
    if (!container || !element) {
      return;
    }

    scrollCommentIntoContainerView(container, element);
  }, [focusedCommentId, focusedCommentRequest]);

  return (
    <div className="merge-request-comments-view" ref={commentsRef}>
      {commentsLoading ? (
        <div aria-live="polite" className="sidebar-scope-status" role="status">
          Loading comments…
        </div>
      ) : commentsError ? (
        <div className="sidebar-scope-status error">{commentsError}</div>
      ) : null}
      {sourceDescription ? (
        <div className="merge-request-comments-source-description">{sourceDescription}</div>
      ) : null}
      {aiReview ? <AIReviewCommentCard review={aiReview} /> : null}
      {threads.length > 0 ? (
        <div className="general-comment-list">
          {threads.map((thread) => (
            <GeneralCommentThreadCard
              canComment={canComment}
              editDraft={editDraft}
              editError={editError}
              editingCommentId={editingCommentId}
              editSubmitting={editSubmitting}
              focusedCommentId={focusedCommentId}
              key={thread.id}
              keymap={keymap}
              onCancelEdit={onCancelEdit}
              onChangeEditDraft={onChangeEditDraft}
              onDelete={(commentId) => {
                void commenting?.onDeleteGeneralComment(commentId).catch((error: unknown) => {
                  window.alert(error instanceof Error ? error.message : String(error));
                });
              }}
              onReply={(threadId, body) =>
                commenting?.onReplyGeneralComment(threadId, body) ??
                Promise.reject(new Error('Replying is unavailable.'))
              }
              onResolve={(threadId, resolved) =>
                commenting?.onResolveDiscussion(threadId, resolved) ??
                Promise.reject(new Error('Resolving is unavailable.'))
              }
              onSaveEdit={onSaveEdit}
              onStartEdit={onStartEdit}
              thread={thread}
            />
          ))}
        </div>
      ) : !aiReview ? (
        <div className="empty-state">
          <div className="empty-panel squircle">
            <strong>No comments yet</strong>
            <span>Add a comment to start the discussion.</span>
          </div>
        </div>
      ) : null}
      {canComment ? (
        <GeneralCommentComposer
          disabled={false}
          draft={draft}
          error={error}
          gitIdentity={gitIdentity}
          keymap={keymap}
          onChangeDraft={onChangeDraft}
          onSubmit={onSubmit}
          submitting={submitting}
        />
      ) : commenting ? (
        <div className="general-comment-sign-in">
          <button className="codiff-open-button" onClick={commenting.onSignIn} type="button">
            Sign in with GitLab to comment
          </button>
        </div>
      ) : null}
    </div>
  );
}

const disabledCommit = async (): Promise<WalkthroughCommitResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'failed',
});

const disabledCommitMessage = async (): Promise<WalkthroughCommitMessageResult> => ({
  reason: 'Shared walkthroughs are read-only.',
  status: 'unavailable',
});

function SharedFileTree({
  files,
  onActivatePath,
  selectedPath,
  showWhitespace,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  selectedPath: string | null;
  showWhitespace: boolean;
}) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const lineCountsByPath = useMemo(
    () => new Map(files.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [files, showWhitespace],
  );
  const lineCountsByPathRef = useRef(lineCountsByPath);
  const renderTreeRowDecoration = useCallback<FileTreeRowDecorationRenderer>(({ item }) => {
    const lineCount = lineCountsByPathRef.current.get(item.path);
    return lineCount?.countable
      ? {
          text: formatTreeLineCount(lineCount),
          title: getDiffLineCountTitle(lineCount),
        }
      : null;
  }, []);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    paths,
    renderRowDecoration: renderTreeRowDecoration,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-bg-override: transparent;
        --trees-bg-muted-override: var(--hover-wash);
        --trees-border-color-override: var(--sidebar-border);
        --trees-fg-muted-override: var(--muted);
        --trees-fg-override: var(--sidebar-text);
        --trees-focus-ring-color-override: var(--tree-selection-focus);
        --trees-padding-inline-override: 4px;
        --trees-search-bg-override: rgb(127 127 127 / 0.1);
        --trees-search-fg-override: var(--sidebar-text);
        --trees-selected-bg-override: color-mix(in srgb, var(--tree-selection-bg) 46%, transparent);
        --trees-selected-fg-override: var(--sidebar-text);
        --trees-selected-focused-border-color-override: color-mix(in srgb, var(--tree-selection-focus) 42%, transparent);
        --truncate-marker-background-color: transparent;
        color-scheme: var(--codiff-tree-color-scheme, light dark);
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        background-color: transparent;
        border-radius: 14px;
        corner-shape: squircle;
      }

      [data-item-section='decoration'] {
        color: var(--muted);
        font: 600 10px/1 var(--font-mono);
        letter-spacing: 0;
      }
    `,
  });

  useLayoutEffect(() => {
    lineCountsByPathRef.current = lineCountsByPath;
    if (model.getFileTreeContainer()) {
      model.render({});
    }
  }, [lineCountsByPath, model]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [model, status]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
  }, [model, selectedPath]);

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  return (
    <div className="file-tree-shell">
      <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
    </div>
  );
}

export type ReviewSurfaceProps = {
  aiReviews?: ReadonlyArray<PullRequestAIReview>;
  commenting?: SharedWalkthroughCommenting;
  commentsError?: string | null;
  commentsLoading?: boolean;
  commits?: ReadonlyArray<MergeRequestCommitListEntry>;
  externalUrl?: string;
  gitIdentity?: GitIdentity | null;
  initialMode?: MergeRequestReviewMode;
  interactive?: {
    onCancelAutoMerge?: () => Promise<void> | void;
    onClosePullRequest?: () => Promise<void> | void;
    onExitVersionCompare?: () => void;
    onGenerateWalkthrough: (options?: {
      force?: boolean;
      reviewStructure?: 'commit-by-commit' | 'whole-diff';
      unitId?: string;
      versionCompare?: {
        fromId: string;
        toId: string;
        walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
      };
    }) => Promise<void> | void;
    onHome: () => void;
    onLoadCommitDiff?: (
      sha: string,
    ) => Promise<ReadonlyArray<ChangedFile>> | ReadonlyArray<ChangedFile>;
    onLoadVersionCommitDiff?: (
      unitId: string,
    ) => Promise<ReadonlyArray<ChangedFile>> | ReadonlyArray<ChangedFile>;
    onMergePullRequest?: (
      options: PullRequestMergeOptions & { autoMerge: boolean },
    ) => Promise<void> | void;
    onOpenVersionCompare?: (options?: { commentId?: string }) => void;
    onResolveDiscussion?: (discussionId: string, resolved: boolean) => Promise<void>;
    onSubmitComment: (
      comment: PullRequestReviewComment,
    ) => Promise<PullRequestExistingReviewComment>;
    onSubmitGeneralComment: (body: string) => Promise<void>;
    onSubmitReview: (
      event: PullRequestReviewEvent,
      comments: ReadonlyArray<PullRequestReviewComment>,
      body?: string,
    ) => Promise<void>;
    onUpdateComment: (commentId: string, body: string) => Promise<void>;
    onUpdateDescription?: (body: string) => Promise<void> | void;
    onUpdateGeneralComment: (commentId: string, body: string) => Promise<void>;
    onUpdateTitle?: (title: string) => Promise<void> | void;
    onUploadDescriptionAsset?: (file: File) => Promise<string> | string;
    onVersionCompareRangeChange?: (fromId: string, toId: string) => void;
    reviewStrategy?: MergeRequestReviewStrategySummary | null;
    walkthroughError?: string | null;
    walkthroughProgress?: WalkthroughGenerationProgress | null;
    walkthroughStatus: MergeRequestWalkthroughStatus;
  };
  onDeleteShare?: () => Promise<void> | void;
  onModeChange?: (mode: MergeRequestReviewMode) => void;
  onVersionWalkthroughStructureChange?: (structure: 'commit-by-commit' | 'whole-diff') => void;
  providerLabel?: string;
  repositoryUrl?: string;
  selectedCommitSha?: string | null;
  settingsBar?: ReactNode;
  signInLabel?: string;
  snapshot: SharedWalkthroughSnapshot;
  sourceDescriptionFooterAside?: ReactNode;
  title?: string;
  versionCommitEvolution?: MergeRequestVersionCommitEvolution | null;
  versionCommitEvolutionError?: string | null;
  versionCommitEvolutionLoading?: boolean;
  versionCompare?: MergeRequestVersionCompareView | null;
  versionCompareEnabled?: boolean;
  versionCompareError?: string | null;
  versionCompareFromId?: string | null;
  versionCompareLoading?: boolean;
  versionCompareToId?: string | null;
  /** Sidebar history section title. GitLab: Versions; GitHub: Head history. */
  versionHistoryLabel?: string;
  versionHistoryLoading?: boolean;
  versionHistoryWarning?: string | null;
  versions?: ReadonlyArray<MergeRequestVersionOption>;
  versionWalkthroughStructure?: 'commit-by-commit' | 'whole-diff';
  /** Baseline scope label. GitLab: Whole MR; GitHub: Whole PR. */
  wholeDiffLabel?: string;
};

const shortRelativeTime = (value: string) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return `${Math.floor(days / 30)}mo ago`;
};

const shortVersionAge = (value: string) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '—';
  }
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / (60 * 1000)));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}w`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
};

export const formatVersionElapsedDuration = (from: string, to: string) => {
  const fromTimestamp = Date.parse(from);
  const toTimestamp = Date.parse(to);
  if (
    !Number.isFinite(fromTimestamp) ||
    !Number.isFinite(toTimestamp) ||
    toTimestamp < fromTimestamp
  ) {
    return '—';
  }
  const minutes = Math.floor((toTimestamp - fromTimestamp) / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}w`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
};

export const resolveVersionWalkthroughFiles = ({
  commitFiles,
  structure,
  versionFiles,
}: {
  commitFiles: ReadonlyArray<ChangedFile> | null | undefined;
  structure: 'commit-by-commit' | 'whole-diff';
  versionFiles: ReadonlyArray<ChangedFile>;
}): ReadonlyArray<ChangedFile> =>
  structure === 'commit-by-commit' ? (commitFiles ?? []) : versionFiles;

export const combineVersionUnitFiles = (
  unitIds: ReadonlyArray<string>,
  filesByUnit: Readonly<Record<string, ReadonlyArray<ChangedFile>>>,
): ReadonlyArray<ChangedFile> => {
  const filesByPath = new Map<string, ChangedFile>();
  for (const unitId of unitIds) {
    for (const file of filesByUnit[unitId] ?? []) {
      const existing = filesByPath.get(file.path);
      if (!existing) {
        filesByPath.set(file.path, { ...file });
        continue;
      }
      filesByPath.set(file.path, {
        ...existing,
        fingerprint: `${existing.fingerprint}:${file.fingerprint}`,
        oldPath: existing.oldPath ?? file.oldPath,
        sections: [...existing.sections, ...file.sections],
        status: existing.status === file.status ? existing.status : 'modified',
      });
    }
  }
  return [...filesByPath.values()];
};

const formatSignedBaseInterval = (delta: number | null) => {
  if (delta == null) {
    return null;
  }
  const duration = formatVersionElapsedDuration(
    new Date(0).toISOString(),
    new Date(Math.abs(delta)).toISOString(),
  );
  return `new base is ${duration} ${delta >= 0 ? 'newer' : 'older'}`;
};

const formatBaseMovementRelationship = (
  relationship: DiffComparisonBaseMovement['relationship'],
) => {
  switch (relationship) {
    case 'forward':
      return 'fast-forward';
    case 'backward':
      return 'rewound';
    case 'divergent':
      return 'divergent histories';
    default:
      return 'relationship unknown';
  }
};

const formatBaseMovementCommitCount = (
  movement: Pick<DiffComparisonBaseMovement, 'commits' | 'commitsBetween' | 'truncated'>,
) => {
  const listed = movement.commits?.length ?? 0;
  const count = movement.commitsBetween ?? (listed > 0 ? listed : null);
  if (count == null) {
    return 'Commit count unavailable';
  }
  const approximate = movement.truncated || (movement.commitsBetween == null && listed > 0);
  return `${approximate ? '≈' : ''}${count} commit${count === 1 ? '' : 's'}`;
};

const VersionPicker = ({
  gitLabProjectUrl,
  label,
  onChange,
  otherId,
  value,
  versions,
}: {
  gitLabProjectUrl?: string;
  label: string;
  onChange: (id: string) => void;
  otherId: string | null;
  value: string;
  versions: ReadonlyArray<MergeRequestVersionOption>;
}) => {
  const selected = versions.find((version) => version.id === value);
  return (
    <Select.Root
      modal={false}
      onValueChange={(nextValue) => {
        if (nextValue) {
          onChange(nextValue);
        }
      }}
      value={value}
    >
      <div className="version-picker">
        <span className="version-picker-label">{label}</span>
        <Select.Trigger aria-label={`${label} version`} className="version-picker-trigger">
          <Select.Value>
            {() => <span>v{selected?.number ?? selected?.range.head.label.text ?? '—'}</span>}
          </Select.Value>
          <Select.Icon aria-hidden>⌄</Select.Icon>
        </Select.Trigger>
      </div>
      <Select.Portal>
        <Select.Positioner
          align="start"
          className="version-picker-positioner"
          side="bottom"
          sideOffset={4}
        >
          <Select.Popup aria-label={`${label} version options`} className="version-picker-popover">
            <Select.List>
              {versions.map((version) => {
                const disabled = version.id === otherId;
                const stat = version.diffStat;
                const createdTimestamp = version.createdAt
                  ? new Date(version.createdAt).toLocaleString()
                  : 'MR base';
                const previousTimestamp = version.previousCreatedAt
                  ? new Date(version.previousCreatedAt).toLocaleString()
                  : null;
                const age = version.number === 0 ? null : shortVersionAge(version.createdAt);
                const elapsed =
                  version.previousCreatedAt && version.previousNumber != null
                    ? formatVersionElapsedDuration(version.previousCreatedAt, version.createdAt)
                    : null;
                const timing = [
                  age ? `${age} old` : null,
                  elapsed ? `${elapsed} since v${version.previousNumber}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                const title = [
                  `v${version.number ?? version.range.head.label.text}`,
                  version.isHead ? 'HEAD' : '',
                  versionOptionHeadSha(version),
                  createdTimestamp,
                  previousTimestamp && version.previousNumber != null
                    ? `${elapsed} since v${version.previousNumber} (${previousTimestamp})`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <Select.Item
                    aria-label={
                      version.number === 0
                        ? `${title}; MR base`
                        : `${title}; +${stat?.additions ?? 'loading'}, −${stat?.deletions ?? 'loading'}, ${stat?.filesChanged ?? 'loading'} ${stat?.filesChanged === 1 ? 'file' : 'files'}; ${timing || 'no timing available'}`
                    }
                    className="version-picker-option"
                    disabled={disabled}
                    key={version.id}
                    label={`v${version.number ?? version.range.head.label.text} ${versionOptionHeadSha(version)}`}
                    title={title}
                    value={version.id}
                  >
                    <span className="version-picker-number">
                      v{version.number ?? version.range.head.label.text}
                    </span>
                    <span className="version-picker-head">{version.isHead ? 'HEAD' : ''}</span>
                    {version.number === 0 ? (
                      <code>base</code>
                    ) : (
                      <CommitRefTooltip
                        commit={{
                          additions: stat?.additions,
                          authoredAt: version.createdAt,
                          deletions: stat?.deletions,
                          sha: versionOptionHeadSha(version),
                          shortSha: versionOptionHeadSha(version).slice(0, 7),
                          subject: `Version v${version.number} head`,
                          webUrl: versionOptionHeadUrl(version, gitLabProjectUrl),
                        }}
                        linkTrigger={false}
                      />
                    )}
                    <span className="version-picker-additions">
                      {version.number === 0 ? '' : `+${stat?.additions ?? '…'}`}
                    </span>
                    <span className="version-picker-deletions">
                      {version.number === 0 ? '' : `−${stat?.deletions ?? '…'}`}
                    </span>
                    <span>
                      {version.number === 0
                        ? ''
                        : `${stat?.filesChanged ?? '…'} ${stat?.filesChanged === 1 ? 'file' : 'files'}`}
                    </span>
                    <span className="version-picker-timing">
                      {version.number === 0 ? 'MR base' : timing || '—'}
                    </span>
                  </Select.Item>
                );
              })}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};

function VersionComparisonEndpoint({
  gitLabProjectUrl,
  version,
}: {
  gitLabProjectUrl?: string;
  version: MergeRequestVersionOption | null | undefined;
}) {
  if (!version) {
    return <span>Version</span>;
  }
  const versionLabel = versionOptionLabel(version);
  const headSha = versionOptionHeadSha(version);
  return (
    <span className="version-comparison-endpoint">
      <span>{versionLabel}</span>
      <CommitRefTooltip
        commit={{
          additions: version.diffStat?.additions,
          authoredAt: version.createdAt,
          deletions: version.diffStat?.deletions,
          sha: headSha,
          shortSha: headSha.slice(0, 7),
          subject: `${versionLabel} head`,
          webUrl: versionOptionHeadUrl(version, gitLabProjectUrl),
        }}
        linkTrigger={false}
      />
    </span>
  );
}

export function ReviewSurface({
  aiReviews = [],
  commenting,
  commentsError = null,
  commentsLoading = false,
  commits = [],
  externalUrl,
  gitIdentity = null,
  initialMode,
  interactive,
  onDeleteShare,
  onModeChange,
  onVersionWalkthroughStructureChange,
  providerLabel = 'provider',
  repositoryUrl,
  selectedCommitSha = null,
  settingsBar,
  signInLabel = 'Sign in to comment',
  snapshot,
  sourceDescriptionFooterAside,
  title,
  versionCommitEvolution = null,
  versionCommitEvolutionError = null,
  versionCommitEvolutionLoading = false,
  versionCompare = null,
  versionCompareEnabled = false,
  versionCompareError = null,
  versionCompareFromId = null,
  versionCompareLoading = false,
  versionCompareToId = null,
  versionHistoryLabel = 'Versions',
  versionHistoryLoading = false,
  versionHistoryWarning = null,
  versions = [],
  versionWalkthroughStructure: versionWalkthroughStructureProp,
  wholeDiffLabel = 'Whole MR',
}: ReviewSurfaceProps) {
  const canComment = commenting?.canComment ?? Boolean(interactive);
  const deleteShare = useCallback(async () => {
    if (
      !onDeleteShare ||
      !window.confirm('Delete this shared walkthrough? This cannot be undone.')
    ) {
      return;
    }
    try {
      await onDeleteShare();
    } catch (error: unknown) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }, [onDeleteShare]);
  const submitReviewComment = commenting?.onSubmitComment ?? interactive?.onSubmitComment;
  const submitGeneralDiscussion =
    commenting?.onSubmitGeneralComment ?? interactive?.onSubmitGeneralComment;
  const updateReviewComment = commenting?.onUpdateComment ?? interactive?.onUpdateComment;
  const updateGeneralDiscussion =
    commenting?.onUpdateGeneralComment ?? interactive?.onUpdateGeneralComment;
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => snapshot.files[0]?.path ?? null,
  );
  const [selectedVersionUnitIds, setSelectedVersionUnitIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [versionUnitFiles, setVersionUnitFiles] = useState<
    Readonly<Record<string, ReadonlyArray<ChangedFile>>>
  >({});
  const [versionUnitLoadingIds, setVersionUnitLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [versionUnitErrors, setVersionUnitErrors] = useState<Readonly<Record<string, string>>>({});
  const versionUnitScopeRef = useRef(0);
  const selectedVersionUnits = useMemo(
    () =>
      (versionCommitEvolution?.units ?? []).filter((unit) => selectedVersionUnitIds.has(unit.id)),
    [selectedVersionUnitIds, versionCommitEvolution],
  );
  const selectedVersionUnitFiles = useMemo(
    () =>
      combineVersionUnitFiles(
        selectedVersionUnits.map((unit) => unit.id),
        versionUnitFiles,
      ),
    [selectedVersionUnits, versionUnitFiles],
  );
  const versionUnitLoading = selectedVersionUnits.some((unit) =>
    versionUnitLoadingIds.has(unit.id),
  );
  const versionUnitError = selectedVersionUnits
    .map((unit) => versionUnitErrors[unit.id])
    .find((error): error is string => Boolean(error));
  const [versionWalkthroughStructureState, setVersionWalkthroughStructureState] = useState<
    'commit-by-commit' | 'whole-diff'
  >('whole-diff');
  const versionWalkthroughStructure =
    versionWalkthroughStructureProp ?? versionWalkthroughStructureState;
  const setVersionWalkthroughStructure = (structure: 'commit-by-commit' | 'whole-diff') => {
    setVersionWalkthroughStructureState(structure);
    onVersionWalkthroughStructureChange?.(structure);
  };
  const [versionSectionExpanded, setVersionSectionExpanded] = useState(true);

  useEffect(() => {
    setSelectedVersionUnitIds(new Set());
    setVersionUnitFiles({});
    setVersionUnitLoadingIds(new Set());
    setVersionUnitErrors({});
    versionUnitScopeRef.current += 1;
  }, [versionCompare?.from.id, versionCompare?.to.id]);

  useEffect(() => {
    if (!versionCommitEvolution) {
      return;
    }
    if (versionWalkthroughStructureProp == null) {
      setVersionWalkthroughStructureState(versionCommitEvolution.recommendation.suggestedStructure);
      onVersionWalkthroughStructureChange?.(
        versionCommitEvolution.recommendation.suggestedStructure,
      );
    }
  }, [
    onVersionWalkthroughStructureChange,
    versionCommitEvolution,
    versionWalkthroughStructureProp,
  ]);

  const loadVersionUnit = useCallback(
    (unit: ReviewEvolutionUnit) => {
      if (versionUnitFiles[unit.id] || versionUnitLoadingIds.has(unit.id)) {
        return;
      }
      if (!interactive?.onLoadVersionCommitDiff) {
        return;
      }
      const scope = versionUnitScopeRef.current;
      setVersionUnitLoadingIds((current) => new Set([...current, unit.id]));
      setVersionUnitErrors((current) => {
        const { [unit.id]: _error, ...rest } = current;
        return rest;
      });
      void Promise.resolve(interactive.onLoadVersionCommitDiff(unit.id))
        .then((files) => {
          if (versionUnitScopeRef.current !== scope) {
            return;
          }
          setVersionUnitFiles((current) => ({ ...current, [unit.id]: files }));
          setSelectedPath((current) => current ?? files[0]?.path ?? null);
        })
        .catch((error: unknown) => {
          if (versionUnitScopeRef.current !== scope) {
            return;
          }
          setVersionUnitErrors((current) => ({
            ...current,
            [unit.id]: error instanceof Error ? error.message : String(error),
          }));
        })
        .finally(() => {
          if (versionUnitScopeRef.current !== scope) {
            return;
          }
          setVersionUnitLoadingIds((current) => {
            const next = new Set(current);
            next.delete(unit.id);
            return next;
          });
        });
    },
    [interactive, versionUnitFiles, versionUnitLoadingIds],
  );
  const toggleVersionUnit = useCallback(
    (unit: ReviewEvolutionUnit) => {
      const selected = selectedVersionUnitIds.has(unit.id);
      const next = new Set(selectedVersionUnitIds);
      if (selected) {
        next.delete(unit.id);
      } else {
        next.add(unit.id);
        loadVersionUnit(unit);
      }
      setSelectedVersionUnitIds(next);
    },
    [loadVersionUnit, selectedVersionUnitIds],
  );
  const selectOnlyVersionUnit = useCallback(
    (unit: ReviewEvolutionUnit) => {
      setSelectedVersionUnitIds(new Set([unit.id]));
      setSelectedPath(null);
      loadVersionUnit(unit);
    },
    [loadVersionUnit],
  );
  const clearVersionUnits = useCallback(() => {
    setSelectedVersionUnitIds(new Set());
    setSelectedPath(versionCompare?.files[0]?.path ?? null);
  }, [versionCompare?.files]);
  const resolveDiscussion = commenting?.onResolveDiscussion ?? interactive?.onResolveDiscussion;
  const sharedWalkthrough = useMemo(
    () => ({
      ...snapshot.walkthrough,
      commit: undefined,
    }),
    [snapshot.walkthrough],
  );
  const [activeCommitSha, setActiveCommitSha] = useState<string | null>(
    () => selectedCommitSha ?? null,
  );
  const [selectedTreeCommitShas, setSelectedTreeCommitShas] = useState<ReadonlySet<string>>(() =>
    selectedCommitSha ? new Set([selectedCommitSha]) : new Set(),
  );
  const [walkthroughCommitSha, setWalkthroughCommitSha] = useState<string | null>(null);
  const [commitFilesBySha, setCommitFilesBySha] = useState<
    Readonly<Record<string, ReadonlyArray<ChangedFile>>>
  >({});
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [treeCommitDiffError, setTreeCommitDiffError] = useState<string | null>(null);
  const [treeCommitDiffLoading, setTreeCommitDiffLoading] = useState(false);
  const commitLoadRequestRef = useRef(0);
  const walkthroughCommitShas = useMemo(
    () => getWalkthroughCommitDiffShas(sharedWalkthrough),
    [sharedWalkthrough],
  );
  const isCommitByCommitWalkthrough = versionCompare
    ? versionWalkthroughStructure === 'commit-by-commit'
    : interactive?.reviewStrategy?.mode === 'commit-by-commit' ||
      sharedWalkthrough.chapters.some((chapter) => chapter.commit != null);
  const legacyWalkthroughNeedsCommitDiffs =
    isCommitByCommitWalkthrough && sharedWalkthrough.commitFiles == null;
  const missingWalkthroughCommitShas = useMemo(
    () =>
      legacyWalkthroughNeedsCommitDiffs
        ? walkthroughCommitShas.filter((sha) => !commitFilesBySha[sha])
        : [],
    [commitFilesBySha, legacyWalkthroughNeedsCommitDiffs, walkthroughCommitShas],
  );
  // CBC walkthroughs are authored against the complete, unit-scoped
  // commitFiles set. Legacy cached walkthroughs have no such set, so they
  // remain empty until every chapter diff has loaded.
  const walkthroughFiles = useMemo(
    () =>
      legacyWalkthroughNeedsCommitDiffs
        ? missingWalkthroughCommitShas.length === 0
          ? combineWalkthroughCommitFiles(walkthroughCommitShas, commitFilesBySha)
          : []
        : versionCompare
          ? resolveVersionWalkthroughFiles({
              commitFiles: sharedWalkthrough.commitFiles,
              structure: versionWalkthroughStructure,
              versionFiles: versionCompare.files,
            })
          : isCommitByCommitWalkthrough
            ? (sharedWalkthrough.commitFiles ?? [])
            : [...snapshot.files, ...(sharedWalkthrough.commitFiles ?? [])],
    [
      commitFilesBySha,
      isCommitByCommitWalkthrough,
      legacyWalkthroughNeedsCommitDiffs,
      missingWalkthroughCommitShas.length,
      sharedWalkthrough.commitFiles,
      snapshot.files,
      versionCompare,
      versionWalkthroughStructure,
      walkthroughCommitShas,
    ],
  );
  const navigation = useNarrativeNavigation(
    sharedWalkthrough,
    walkthroughFiles,
    `${snapshot.repository.root}:${getSourceKey(snapshot.repository.source)}:${versionCompare?.from.id ?? ''}:${versionCompare?.to.id ?? ''}`,
  );
  const keymap = useMemo(() => createDefaultConfig().keymap, []);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGenerated, setExpandedGenerated] = useState<ReadonlySet<string>>(() => new Set());
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [itemVersionByKey, setItemVersionByKey] = useState<Record<string, number>>({});
  const [sidebarWidth, setSidebarWidth] = useState(readSharedSidebarWidth);
  const [uncontrolledSidebarMode, setUncontrolledSidebarMode] = useState<MergeRequestReviewMode>(
    () => initialMode ?? (interactive ? 'tree' : 'walkthrough'),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isSidebarModeControlled = Boolean(initialMode && onModeChange);
  const sidebarMode =
    isSidebarModeControlled && initialMode ? initialMode : uncontrolledSidebarMode;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !matchesShortcut(event, keymap, 'toggleSidebar')) {
        return;
      }
      event.preventDefault();
      setSidebarCollapsed((current) => !current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keymap]);
  useEffect(() => {
    if (sidebarMode !== 'walkthrough' || navigation.mode !== 'stop') {
      return;
    }
    const stop = navigation.walkthroughView?.sequence[navigation.index];
    const chapter = navigation.walkthroughView?.chapters.find(
      (candidate) => candidate.id === stop?.chapterId,
    );
    if (!versionCompare) {
      const commitSha =
        chapter?.commit?.sha ??
        commits.find((commit) => chapter?.id.startsWith(`${commit.sha}:`))?.sha;
      setWalkthroughCommitSha(commitSha ?? null);
    }
  }, [
    navigation.index,
    navigation.mode,
    navigation.walkthroughView,
    sidebarMode,
    commits,
    versionCompare,
  ]);
  const [treeScrollTarget, setTreeScrollTarget] = useState<ReviewScrollTarget | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const walkthroughGenerationOptionsRef = useRef<{
    force?: boolean;
    reviewStructure?: 'commit-by-commit' | 'whole-diff';
    unitId?: string;
    versionCompare?: {
      fromId: string;
      toId: string;
      walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
    };
  } | null>(null);
  const queuedWalkthroughGenerationOptionsRef =
    useRef<typeof walkthroughGenerationOptionsRef.current>(null);
  const [queuedReviewStructure, setQueuedReviewStructure] = useState<
    'commit-by-commit' | 'whole-diff' | null
  >(null);
  const [baselineWalkthroughStructureOverride, setBaselineWalkthroughStructureOverride] = useState<
    'commit-by-commit' | 'whole-diff' | null
  >(null);
  const snapshotReviewComments = useMemo(() => getSnapshotReviewComments(snapshot), [snapshot]);
  const [editedReviewCommentBodies, setEditedReviewCommentBodies] = useState<
    Readonly<Record<string, string>>
  >({});
  const visibleSnapshotReviewComments = useMemo(
    () =>
      snapshotReviewComments.map((comment) =>
        editedReviewCommentBodies[comment.id] != null &&
        editedReviewCommentBodies[comment.id] !== comment.body
          ? { ...comment, body: editedReviewCommentBodies[comment.id] }
          : comment,
      ),
    [editedReviewCommentBodies, snapshotReviewComments],
  );
  const [localReviewComments, setLocalReviewComments] =
    useState<ReadonlyArray<ReviewComment>>(emptyReviewComments);
  const [showResolvedComments, setShowResolvedComments] = useState(() => {
    if (typeof localStorage === 'undefined') {
      return true;
    }
    return localStorage.getItem(showResolvedCommentsStorageKey) !== 'false';
  });
  useEffect(() => {
    localStorage.setItem(showResolvedCommentsStorageKey, String(showResolvedComments));
  }, [showResolvedComments]);
  const allReviewComments = useMemo(
    () => [...visibleSnapshotReviewComments, ...localReviewComments],
    [localReviewComments, visibleSnapshotReviewComments],
  );
  const reviewComments = useMemo(
    () =>
      showResolvedComments
        ? allReviewComments
        : allReviewComments.filter((comment) => comment.isThreadResolved !== true),
    [allReviewComments, showResolvedComments],
  );
  const sidebarCodeComments = useMemo(
    () =>
      (snapshot.reviewComments ?? emptyExistingReviewComments).filter(
        (comment) => showResolvedComments || comment.isThreadResolved !== true,
      ),
    [showResolvedComments, snapshot.reviewComments],
  );
  const reviewCommentsRef = useRef(reviewComments);
  const generalCommentThreads = useMemo(
    () =>
      (snapshot.repository.generalComments ?? emptyGeneralCommentThreads).filter(
        (thread) => showResolvedComments || thread.isResolved !== true,
      ),
    [showResolvedComments, snapshot.repository.generalComments],
  );
  const overviewComments = useMemo(
    () =>
      generalCommentThreads.flatMap((thread) =>
        thread.comments.map((comment) => ({
          canResolve: thread.canResolve === true,
          comment,
          isResolved: thread.isResolved === true,
        })),
      ),
    [generalCommentThreads],
  );
  const generalComments = useMemo(
    () => overviewComments.map(({ comment }) => comment),
    [overviewComments],
  );
  const generalCommentCount = generalComments.length;
  const orderedAIReviews = useMemo(
    () =>
      aiReviews.toSorted(
        (first, second) =>
          Date.parse(second.submittedAt ?? '') - Date.parse(first.submittedAt ?? ''),
      ),
    [aiReviews],
  );
  const [selectedAIReviewId, setSelectedAIReviewId] = useState<string | null>(
    () => orderedAIReviews[0]?.id ?? null,
  );
  useEffect(() => {
    setSelectedAIReviewId((current) =>
      orderedAIReviews.some((review) => review.id === current)
        ? current
        : (orderedAIReviews[0]?.id ?? null),
    );
  }, [orderedAIReviews]);
  const selectedAIReview =
    orderedAIReviews.find((review) => review.id === selectedAIReviewId) ??
    orderedAIReviews[0] ??
    null;
  const [generalCommentDraft, setGeneralCommentDraft] = useState('');
  const [generalCommentEditDraft, setGeneralCommentEditDraft] = useState('');
  const [editingGeneralCommentId, setEditingGeneralCommentId] = useState<string | null>(null);
  const [generalCommentEditError, setGeneralCommentEditError] = useState<string | null>(null);
  const [generalCommentEditSubmitting, setGeneralCommentEditSubmitting] = useState(false);
  const [generalCommentError, setGeneralCommentError] = useState<string | null>(null);
  const [focusedGeneralCommentId, setFocusedGeneralCommentId] = useState<string | null>(null);
  const [generalCommentScrollRequest, setGeneralCommentScrollRequest] = useState(0);
  const [generalCommentSubmitting, setGeneralCommentSubmitting] = useState(false);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [focusCommentRequest, setFocusCommentRequest] = useState(0);
  const [activeReviewCommentDraftState, setActiveReviewCommentDraftState] = useState<Pick<
    ReviewComment,
    'body' | 'id'
  > | null>(null);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] =
    useState<PullRequestReviewEvent | null>(null);
  const [pullRequestCloseSubmitting, setPullRequestCloseSubmitting] = useState(false);
  const [pullRequestMergeSubmitting, setPullRequestMergeSubmitting] = useState(false);
  const [walkthroughRequestPending, setWalkthroughRequestPending] = useState(false);
  const walkthroughRequestPendingRef = useRef(false);
  const walkthroughRequestForceRef = useRef(false);
  const lastAutoVersionWalkthroughKeyRef = useRef<string | null>(null);
  const [walkthroughRequestForce, setWalkthroughRequestForce] = useState(false);
  const [walkthroughRequestId, setWalkthroughRequestId] = useState(0);
  const activeReviewCommentDraftRef = useRef<Pick<ReviewComment, 'body' | 'id'> | null>(null);
  const interactiveRef = useRef(interactive);

  useEffect(() => {
    reviewCommentsRef.current = reviewComments;
  }, [reviewComments]);

  const activeCommit = useMemo(
    () => commits.find((commit) => commit.sha === activeCommitSha) ?? null,
    [activeCommitSha, commits],
  );
  const activeCommitFiles = activeCommitSha ? (commitFilesBySha[activeCommitSha] ?? null) : null;
  const selectedTreeCommitFiles = useMemo(
    () => combineVersionUnitFiles([...selectedTreeCommitShas], commitFilesBySha),
    [commitFilesBySha, selectedTreeCommitShas],
  );
  const versionCompareActive =
    versionCompareEnabled === true || versionCompare != null || versionCompareLoading;
  const versionCompareChangedPaths = useMemo(() => {
    const files =
      sidebarMode === 'walkthrough' && versionCompare
        ? walkthroughFiles
        : selectedVersionUnitIds.size > 0
          ? selectedVersionUnitFiles
          : (versionCompare?.files ?? []);
    return new Set(files.map((file) => file.path));
  }, [
    selectedVersionUnitFiles,
    selectedVersionUnitIds.size,
    sidebarMode,
    versionCompare,
    walkthroughFiles,
  ]);
  const versionCompareWalkthroughOptions = useMemo(
    () =>
      versionCompare
        ? {
            versionCompare: {
              fromId: versionCompare.from.id,
              toId: versionCompare.to.id,
              walkthroughStructure: versionWalkthroughStructure,
            },
          }
        : undefined,
    [versionCompare, versionWalkthroughStructure],
  );
  const reviewFiles = versionCompare
    ? selectedVersionUnitIds.size > 0
      ? selectedVersionUnitFiles
      : versionCompare.files
    : sidebarMode === 'tree' && selectedTreeCommitShas.size > 0
      ? selectedTreeCommitFiles
      : snapshot.files;
  const visibleFiles = useMemo(
    () =>
      sortFiles(reviewFiles).filter(
        (file) =>
          fuzzyMatches(file.path, sidebarMode === 'tree' ? fileSearchQuery : '') &&
          fileHasVisibleDiff(file, snapshot.preferences.showWhitespace),
      ),
    [fileSearchQuery, reviewFiles, sidebarMode, snapshot.preferences.showWhitespace],
  );
  const commentAssociationById = useMemo(() => {
    const map = new Map<string, MergeRequestVersionCompareCommentAssociation>();
    for (const association of versionCompare?.analysis.commentAssociations ?? []) {
      map.set(association.commentId, association);
    }
    return map;
  }, [versionCompare]);
  const totalLineCount = useMemo(
    () =>
      getTotalDiffLineCount(
        visibleFiles.map((file) => getDiffLineCount(file, snapshot.preferences.showWhitespace)),
      ),
    [snapshot.preferences.showWhitespace, visibleFiles],
  );
  const showTotalLineCount =
    sidebarMode !== 'comments' && sidebarMode !== 'commits' && totalLineCount.countable;

  useEffect(() => {
    if (selectedCommitSha) {
      setActiveCommitSha(selectedCommitSha);
      setSelectedTreeCommitShas(new Set([selectedCommitSha]));
    }
  }, [selectedCommitSha]);

  const commitDiffTargetSha =
    sidebarMode === 'commits'
      ? activeCommitSha
      : sidebarMode === 'walkthrough' && !legacyWalkthroughNeedsCommitDiffs
        ? walkthroughCommitSha
        : null;
  useEffect(() => {
    if (sidebarMode === 'walkthrough' && legacyWalkthroughNeedsCommitDiffs) {
      if (missingWalkthroughCommitShas.length === 0 || !interactive?.onLoadCommitDiff) {
        return;
      }
      const requestId = commitLoadRequestRef.current + 1;
      commitLoadRequestRef.current = requestId;
      setCommitDiffLoading(true);
      setCommitDiffError(null);
      void Promise.all(
        missingWalkthroughCommitShas.map((sha) =>
          Promise.resolve(interactive.onLoadCommitDiff!(sha)).then((files) => ({ files, sha })),
        ),
      )
        .then((results) => {
          if (commitLoadRequestRef.current !== requestId) {
            return;
          }
          setCommitFilesBySha((current) => ({
            ...current,
            ...Object.fromEntries(results.map(({ files, sha }) => [sha, files])),
          }));
        })
        .catch((error: unknown) => {
          if (commitLoadRequestRef.current !== requestId) {
            return;
          }
          setCommitDiffError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (commitLoadRequestRef.current === requestId) {
            setCommitDiffLoading(false);
          }
        });
      return;
    }
    if (
      (sidebarMode !== 'commits' && sidebarMode !== 'walkthrough') ||
      !commitDiffTargetSha ||
      !interactive?.onLoadCommitDiff
    ) {
      return;
    }
    if (commitFilesBySha[commitDiffTargetSha]) {
      return;
    }
    const requestId = commitLoadRequestRef.current + 1;
    commitLoadRequestRef.current = requestId;
    setCommitDiffLoading(true);
    setCommitDiffError(null);
    void Promise.resolve(interactive.onLoadCommitDiff(commitDiffTargetSha))
      .then((files) => {
        if (commitLoadRequestRef.current !== requestId) {
          return;
        }
        setCommitFilesBySha((current) => ({ ...current, [commitDiffTargetSha]: files }));
        setSelectedPath(files[0]?.path ?? null);
      })
      .catch((error: unknown) => {
        if (commitLoadRequestRef.current !== requestId) {
          return;
        }
        setCommitDiffError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (commitLoadRequestRef.current === requestId) {
          setCommitDiffLoading(false);
        }
      });
  }, [
    commitDiffTargetSha,
    commitFilesBySha,
    interactive,
    legacyWalkthroughNeedsCommitDiffs,
    missingWalkthroughCommitShas,
    sidebarMode,
  ]);

  useEffect(() => {
    if (
      sidebarMode !== 'tree' ||
      versionCompareActive ||
      selectedTreeCommitShas.size === 0 ||
      !interactive?.onLoadCommitDiff
    ) {
      return;
    }
    const missingShas = [...selectedTreeCommitShas].filter((sha) => !commitFilesBySha[sha]);
    if (missingShas.length === 0) {
      return;
    }
    let cancelled = false;
    setTreeCommitDiffLoading(true);
    setTreeCommitDiffError(null);
    void Promise.all(
      missingShas.map((sha) =>
        Promise.resolve(interactive.onLoadCommitDiff!(sha)).then((files) => ({ files, sha })),
      ),
    )
      .then((results) => {
        if (cancelled) {
          return;
        }
        setCommitFilesBySha((current) => ({
          ...current,
          ...Object.fromEntries(results.map(({ files, sha }) => [sha, files])),
        }));
        setSelectedPath((current) => current ?? results[0]?.files[0]?.path ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTreeCommitDiffError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTreeCommitDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [commitFilesBySha, interactive, selectedTreeCommitShas, sidebarMode, versionCompareActive]);
  const visibleSelectedPath =
    selectedPath && visibleFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleFiles[0]?.path ?? null);
  const initialMarkdownPreviewSectionIds = useMemo(() => {
    const nonGeneratedFiles = snapshot.files.filter((file) => !isGeneratedWalkthroughFile(file));
    if (
      nonGeneratedFiles.length === 0 ||
      !nonGeneratedFiles.every((file) => isMarkdownFilePath(file.path))
    ) {
      return emptyPaths;
    }

    return new Set(
      snapshot.files
        .filter((file) => isMarkdownFilePath(file.path))
        .flatMap((file) => file.sections.map((section) => section.id)),
    );
  }, [snapshot.files]);

  useEffect(() => {
    const root = document.documentElement;
    if (snapshot.preferences.theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', snapshot.preferences.theme);
    }
  }, [snapshot.preferences.theme]);

  useEffect(() => {
    const root = document.documentElement;
    const codeFontFamily = snapshot.preferences.codeFontFamily.trim();
    const codeFontSize = normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize);

    if (codeFontFamily) {
      root.style.setProperty('--font-diff-mono', `${JSON.stringify(codeFontFamily)}, monospace`);
    }

    root.style.setProperty('--font-diff-size', `${codeFontSize}px`);
    root.style.setProperty('--font-diff-line-height', `${getCodeFontLineHeight(codeFontSize)}px`);
  }, [snapshot.preferences.codeFontFamily, snapshot.preferences.codeFontSize]);

  const bumpItemVersion = useCallback((key: string) => {
    setItemVersionByKey((current) => ({
      ...current,
      [key]: (current[key] ?? 0) + 1,
    }));
  }, []);
  const changeSidebarMode = useCallback(
    (mode: MergeRequestReviewMode) => {
      setUncontrolledSidebarMode(mode);
      onModeChange?.(mode);
    },
    [onModeChange],
  );

  const selectCommit = useCallback(
    (sha: string) => {
      if (versionCompareActive) {
        interactive?.onExitVersionCompare?.();
      }
      setActiveCommitSha(sha);
      setSelectedTreeCommitShas(new Set([sha]));
      setCommitDiffError(null);
      setTreeCommitDiffError(null);
      changeSidebarMode('tree');
    },
    [changeSidebarMode, versionCompareActive, interactive],
  );

  const createComment = useCallback(
    (comment: Omit<ReviewComment, 'body' | 'id'>) => {
      if (!canComment) {
        return;
      }

      const emptyExistingComment = reviewCommentsRef.current.find(
        (candidate) =>
          candidate.body.length === 0 && getCommentKey(candidate) === getCommentKey(comment),
      );
      if (emptyExistingComment) {
        setFocusCommentId(emptyExistingComment.id);
        setFocusCommentRequest((current) => current + 1);
        return;
      }

      const emptyDraft = reviewCommentsRef.current.find(
        (candidate) => !candidate.isReadOnly && candidate.body.length === 0,
      );
      if (emptyDraft) {
        const id = crypto.randomUUID();
        setFocusCommentId(id);
        setFocusCommentRequest((current) => current + 1);
        setLocalReviewComments((current) =>
          current.map((candidate) =>
            candidate.id === emptyDraft.id
              ? {
                  ...comment,
                  body: '',
                  id,
                }
              : candidate,
          ),
        );
        bumpItemVersion(emptyDraft.filePath);
        bumpItemVersion(comment.filePath);
        return;
      }

      const id = crypto.randomUUID();
      setFocusCommentId(id);
      setFocusCommentRequest((current) => current + 1);
      setLocalReviewComments((current) => [...current, { ...comment, body: '', id }]);
      bumpItemVersion(comment.filePath);
    },
    [bumpItemVersion, canComment],
  );
  const activateGeneralComment = useCallback(
    (commentId: string) => {
      changeSidebarMode('comments');
      setFocusedGeneralCommentId(commentId);
      setGeneralCommentScrollRequest((current) => current + 1);
    },
    [changeSidebarMode],
  );
  const activateReviewComment = useCallback(
    (commentId: string) => {
      changeSidebarMode('tree');
      setFocusCommentId(commentId);
      setFocusCommentRequest((current) => current + 1);
    },
    [changeSidebarMode],
  );
  const navigateGeneralComment = useCallback(
    (direction: 1 | -1) => {
      if (generalComments.length === 0) {
        return;
      }

      const currentIndex = focusedGeneralCommentId
        ? generalComments.findIndex((comment) => comment.id === focusedGeneralCommentId)
        : -1;
      const nextIndex =
        currentIndex === -1
          ? direction > 0
            ? 0
            : generalComments.length - 1
          : Math.min(generalComments.length - 1, Math.max(0, currentIndex + direction));
      const nextComment = generalComments[nextIndex];

      if (nextComment) {
        activateGeneralComment(nextComment.id);
      }
    },
    [activateGeneralComment, focusedGeneralCommentId, generalComments],
  );
  const updateComment = useCallback((commentId: string, body: string) => {
    const applyCommentBody = (comments: ReadonlyArray<ReviewComment>) =>
      comments.map((comment) =>
        comment.id === commentId && !comment.isReadOnly ? { ...comment, body } : comment,
      );

    reviewCommentsRef.current = applyCommentBody(reviewCommentsRef.current);
    setLocalReviewComments(applyCommentBody);
  }, []);
  const updateActiveReviewCommentDraft = useCallback(
    (comment: Pick<ReviewComment, 'body' | 'id'> | null) => {
      activeReviewCommentDraftRef.current = comment;
      setActiveReviewCommentDraftState((current) => {
        if (comment == null) {
          return current == null ? current : null;
        }

        const body = comment.body.trim().length > 0 ? 'pending' : '';
        return current?.id === comment.id && current.body === body
          ? current
          : { body, id: comment.id };
      });
    },
    [],
  );
  const updateExistingReviewComment = useCallback(
    async (commentId: string, body: string) => {
      if (!updateReviewComment) {
        return;
      }
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      await updateReviewComment(commentId, body);
      setEditedReviewCommentBodies((current) => ({ ...current, [commentId]: body }));
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion, updateReviewComment],
  );
  const deleteComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      updateActiveReviewCommentDraft(null);
      if (comment?.isReadOnly && comment.canDelete && commenting?.onDeleteComment) {
        void commenting.onDeleteComment(commentId).catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      setFocusCommentId((current) => (current === commentId ? null : current));
      setLocalReviewComments((current) =>
        current.filter((candidate) => candidate.id !== commentId),
      );
      if (comment) {
        bumpItemVersion(comment.filePath);
      }
    },
    [bumpItemVersion, commenting, updateActiveReviewCommentDraft],
  );
  const submitComment = useCallback(
    (commentId: string) => {
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !submitReviewComment ||
        !comment ||
        comment.isReadOnly ||
        !comment.body.trim() ||
        comment.remoteSubmit?.status === 'submitting'
      ) {
        return;
      }

      updateActiveReviewCommentDraft(null);
      setLocalReviewComments((current) =>
        current.map((candidate) =>
          candidate.id === commentId
            ? { ...candidate, remoteSubmit: { status: 'submitting' } }
            : candidate,
        ),
      );
      void submitReviewComment(toPullRequestReviewComment(comment))
        .then(() => {
          setFocusCommentId((current) => (current === commentId ? null : current));
          setLocalReviewComments((current) =>
            current.filter((candidate) => candidate.id !== commentId),
          );
          bumpItemVersion(comment.filePath);
        })
        .catch((error: unknown) => {
          setLocalReviewComments((current) =>
            current.map((candidate) =>
              candidate.id === commentId
                ? {
                    ...candidate,
                    remoteSubmit: {
                      error: error instanceof Error ? error.message : String(error),
                      status: 'error',
                    },
                  }
                : candidate,
            ),
          );
          bumpItemVersion(comment.filePath);
        });
    },
    [bumpItemVersion, submitReviewComment, updateActiveReviewCommentDraft],
  );
  const submitReview = useCallback(
    (event: PullRequestReviewEvent, body?: string) => {
      const source = snapshot.repository.source;
      if (
        !interactive ||
        pullRequestReviewSubmitting ||
        (source.type === 'pull-request' &&
          isPullRequestReviewActionDisabled(source.reviewStatus, event))
      ) {
        return;
      }

      const pendingComments = getPendingPullRequestReviewComments(
        reviewCommentsRef.current,
        activeReviewCommentDraftRef.current,
      );
      if (event === 'COMMENT' && pendingComments.length === 0 && !body?.trim()) {
        return;
      }
      const pendingIds = new Set(pendingComments.map((comment) => comment.id));
      setPullRequestReviewSubmitting(event);
      const formattedComments = pendingComments.map(toPullRequestReviewComment);
      const submission = body
        ? interactive.onSubmitReview(event, formattedComments, body)
        : interactive.onSubmitReview(event, formattedComments);
      return submission
        .then(() => {
          updateActiveReviewCommentDraft(null);
          setLocalReviewComments((current) =>
            current.filter((comment) => !pendingIds.has(comment.id)),
          );
        })
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
          throw error;
        })
        .finally(() => setPullRequestReviewSubmitting(null));
    },
    [
      interactive,
      pullRequestReviewSubmitting,
      snapshot.repository.source,
      updateActiveReviewCommentDraft,
    ],
  );
  const closePullRequest = useCallback(() => {
    const source = snapshot.repository.source;
    if (
      !interactive?.onClosePullRequest ||
      pullRequestCloseSubmitting ||
      source.type !== 'pull-request' ||
      source.reviewStatus?.close?.disabled === true ||
      !source.reviewStatus?.close
    ) {
      return;
    }

    setPullRequestCloseSubmitting(true);
    void Promise.resolve(interactive.onClosePullRequest())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestCloseSubmitting(false));
  }, [interactive, pullRequestCloseSubmitting, snapshot.repository.source]);
  const mergePullRequest = useCallback(
    (options: PullRequestMergeOptions & { autoMerge: boolean }) => {
      if (!interactive?.onMergePullRequest || pullRequestMergeSubmitting) {
        return;
      }

      setPullRequestMergeSubmitting(true);
      void Promise.resolve(interactive.onMergePullRequest(options))
        .catch((error: unknown) => {
          window.alert(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setPullRequestMergeSubmitting(false));
    },
    [interactive, pullRequestMergeSubmitting],
  );
  const cancelAutoMerge = useCallback(() => {
    if (!interactive?.onCancelAutoMerge || pullRequestMergeSubmitting) {
      return;
    }

    setPullRequestMergeSubmitting(true);
    void Promise.resolve(interactive.onCancelAutoMerge())
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPullRequestMergeSubmitting(false));
  }, [interactive, pullRequestMergeSubmitting]);
  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);

  const beginWalkthroughGeneration = useCallback(
    (options: typeof walkthroughGenerationOptionsRef.current) => {
      walkthroughGenerationOptionsRef.current = options;
      walkthroughRequestPendingRef.current = true;
      walkthroughRequestForceRef.current = options?.force === true;
      setWalkthroughRequestForce(options?.force === true);
      setWalkthroughRequestPending(true);
      setWalkthroughRequestId((current) => current + 1);
    },
    [],
  );

  useEffect(() => {
    if (!walkthroughRequestPending || walkthroughRequestId === 0) {
      return;
    }

    let cancelled = false;
    const options = walkthroughGenerationOptionsRef.current;
    walkthroughGenerationOptionsRef.current = null;
    void Promise.resolve(interactiveRef.current?.onGenerateWalkthrough(options ?? undefined))
      .catch(() => {})
      .finally(() => {
        if (cancelled) {
          return;
        }
        walkthroughRequestPendingRef.current = false;
        walkthroughRequestForceRef.current = false;
        setWalkthroughRequestPending(false);
        setWalkthroughRequestForce(false);
        const queuedOptions = queuedWalkthroughGenerationOptionsRef.current;
        if (queuedOptions) {
          queuedWalkthroughGenerationOptionsRef.current = null;
          setQueuedReviewStructure(null);
          queueMicrotask(() => beginWalkthroughGeneration(queuedOptions));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [beginWalkthroughGeneration, walkthroughRequestId, walkthroughRequestPending]);

  const startWalkthroughGeneration = useCallback(
    (options?: {
      force?: boolean;
      reviewStructure?: 'commit-by-commit' | 'whole-diff';
      unitId?: string;
      versionCompare?: {
        fromId: string;
        toId: string;
        walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
      };
    }) => {
      if (options?.reviewStructure) {
        setBaselineWalkthroughStructureOverride(options.reviewStructure);
      }
      if (
        !interactive ||
        interactive.walkthroughStatus === 'generating' ||
        walkthroughRequestPendingRef.current
      ) {
        if (interactive && options?.force && options.reviewStructure) {
          queuedWalkthroughGenerationOptionsRef.current = options;
          setQueuedReviewStructure(options.reviewStructure);
        }
        return;
      }

      beginWalkthroughGeneration(options ?? null);
    },
    [beginWalkthroughGeneration, interactive],
  );
  useEffect(() => {
    if (sidebarMode !== 'walkthrough') {
      return;
    }
    if (versionCompareActive) {
      if (!versionCompareWalkthroughOptions) {
        return;
      }
      const key = [
        versionCompareWalkthroughOptions.versionCompare.fromId,
        versionCompareWalkthroughOptions.versionCompare.toId,
        versionCompareWalkthroughOptions.versionCompare.walkthroughStructure,
      ].join(':');
      // Auto-resolve whenever the version range/structure changes, including cache hits.
      // Skip while a request is already in flight or actively generating.
      if (
        lastAutoVersionWalkthroughKeyRef.current === key &&
        (interactive?.walkthroughStatus === 'ready' ||
          interactive?.walkthroughStatus === 'generating' ||
          walkthroughRequestPending)
      ) {
        return;
      }
      if (interactive?.walkthroughStatus === 'generating' || walkthroughRequestPending) {
        return;
      }
      lastAutoVersionWalkthroughKeyRef.current = key;
      queueMicrotask(() => startWalkthroughGeneration(versionCompareWalkthroughOptions));
      return;
    }
    if (interactive?.walkthroughStatus === 'idle') {
      queueMicrotask(() => startWalkthroughGeneration());
    }
  }, [
    interactive?.walkthroughStatus,
    sidebarMode,
    startWalkthroughGeneration,
    versionCompareActive,
    versionCompareWalkthroughOptions,
    walkthroughRequestPending,
  ]);

  useEffect(() => {
    if (sidebarMode !== 'comments' || generalComments.length === 0) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isNativeInputTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') {
        return;
      }

      event.preventDefault();
      navigateGeneralComment(key === 'j' ? 1 : -1);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [generalComments.length, navigateGeneralComment, sidebarMode]);
  const submitGeneralComment = useCallback(() => {
    const body = generalCommentDraft.trim();
    if (!submitGeneralDiscussion || !body || generalCommentSubmitting) {
      return;
    }

    setGeneralCommentError(null);
    setGeneralCommentSubmitting(true);
    void Promise.resolve(submitGeneralDiscussion(body))
      .then(() => setGeneralCommentDraft(''))
      .catch((error: unknown) => {
        setGeneralCommentError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setGeneralCommentSubmitting(false));
  }, [generalCommentDraft, generalCommentSubmitting, submitGeneralDiscussion]);
  const startEditGeneralComment = useCallback((comment: PullRequestGeneralComment) => {
    if (!comment.canEdit) {
      return;
    }

    setEditingGeneralCommentId(comment.id);
    setGeneralCommentEditDraft(comment.body);
    setGeneralCommentEditError(null);
  }, []);
  const cancelEditGeneralComment = useCallback(() => {
    if (generalCommentEditSubmitting) {
      return;
    }

    setEditingGeneralCommentId(null);
    setGeneralCommentEditDraft('');
    setGeneralCommentEditError(null);
  }, [generalCommentEditSubmitting]);
  const saveGeneralCommentEdit = useCallback(() => {
    const commentId = editingGeneralCommentId;
    const body = generalCommentEditDraft.trim();
    if (!updateGeneralDiscussion || !commentId || !body || generalCommentEditSubmitting) {
      return;
    }

    setGeneralCommentEditError(null);
    setGeneralCommentEditSubmitting(true);
    void Promise.resolve(updateGeneralDiscussion(commentId, body))
      .then(() => {
        setEditingGeneralCommentId(null);
        setGeneralCommentEditDraft('');
      })
      .catch((error: unknown) => {
        setGeneralCommentEditError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setGeneralCommentEditSubmitting(false));
  }, [
    editingGeneralCommentId,
    generalCommentEditDraft,
    generalCommentEditSubmitting,
    updateGeneralDiscussion,
  ]);
  const resizeSidebar = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    const handle = event.currentTarget;
    const shell = handle.parentElement;
    if (!shell) {
      return;
    }

    const shellLeft = shell.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';

    const cleanup = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', handleMove);
      handle.removeEventListener('pointerup', handleEnd);
      handle.removeEventListener('pointercancel', handleEnd);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
    };

    const handleMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(moveEvent.clientX - shellLeft));
    };

    const handleEnd = () => {
      cleanup();
      setSidebarWidth((width) => {
        writeSharedSidebarWidth(width);
        return width;
      });
    };

    handle.addEventListener('pointermove', handleMove);
    handle.addEventListener('pointerup', handleEnd);
    handle.addEventListener('pointercancel', handleEnd);
  }, []);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean, reviewKey: string) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(reviewKey);
        } else {
          next.add(reviewKey);
        }
        return next;
      });
      setExpandedGenerated((current) => {
        const next = new Set(current);
        if (isCollapsed && isGeneratedWalkthroughFile(file)) {
          next.add(reviewKey);
        } else {
          next.delete(reviewKey);
        }
        return next;
      });
      bumpItemVersion(reviewKey);
    },
    [bumpItemVersion],
  );
  const toggleViewed = useCallback(
    (_file: ChangedFile, isViewed: boolean, reviewIdentity: ReviewIdentity) => {
      setViewed((current) => updateReviewIdentityViewed(current, reviewIdentity, isViewed));
      setCollapsed((current) => updateReviewIdentityCollapsed(current, reviewIdentity, isViewed));
      if (!isViewed) {
        setExpandedGenerated((current) => {
          const next = new Set(current);
          next.delete(reviewIdentity.key);
          return next;
        });
      }
      bumpItemVersion(reviewIdentity.key);
    },
    [bumpItemVersion],
  );
  const activateTreePath = useCallback((path: string) => {
    setSelectedPath(path);
    setTreeScrollTarget((current) => ({
      behavior: 'smooth',
      path,
      request: (current?.request ?? 0) + 1,
    }));
  }, []);
  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (visibleFiles.length === 0) {
        return;
      }

      const activationTop = viewer.getScrollTop() + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, snapshot.preferences.showWhitespace);
        const itemTop = section ? viewer.getTopForItem(getItemId(section)) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [snapshot.preferences.showWhitespace, visibleFiles],
  );

  const diffLineHeight = getCodeFontLineHeight(
    normalizeCodeFontSizePreference(snapshot.preferences.codeFontSize),
  );
  const commonReviewProps = {
    activeSearchMatch: null,
    agentId: snapshot.walkthrough.agent,
    agentLabel: getAgentLabel(snapshot.walkthrough.agent),
    codeQualityFindings: snapshot.codeQualityFindings,
    collapsed,
    comments: reviewComments,
    commitMetadata: null,
    diffLineHeight,
    diffStyle: snapshot.preferences.diffStyle,
    disableWorkerPool: true,
    expandedGenerated,
    focusCommentId,
    focusCommentRequest,
    gitIdentity,
    hunkNavigation: null,
    initialMarkdownPreviewSectionIds,
    isPullRequest: snapshot.repository.source.type === 'pull-request',
    isReadOnly: !canComment,
    itemVersionByKey,
    keymap,
    loadingSectionIds: new Set<string>(),
    onCommentDraftChange: updateActiveReviewCommentDraft,
    onCreateComment: createComment,
    onDeleteComment: deleteComment,
    onLoadSection: noop,
    onResolveThread: resolveDiscussion ?? noop,
    onSaveCommentEdit: updateExistingReviewComment,
    onSelectPathFromScroll: noop,
    onSubmitComment: submitComment,
    onToggleCollapsed: toggleCollapsed,
    onToggleViewed: toggleViewed,
    onUpdateComment: updateComment,
    onUpdateSourceDescription: interactive?.onUpdateDescription,
    onUpdateSourceTitle: interactive?.onUpdateTitle,
    onUploadSourceDescriptionAsset: interactive?.onUploadDescriptionAsset,
    searchQuery: '',
    showWhitespace: snapshot.preferences.showWhitespace,
    source: snapshot.repository.source,
    theme: snapshot.preferences.theme,
    viewed,
    wordWrap: snapshot.preferences.wordWrap,
  };
  const source = snapshot.repository.source;
  const sourceMergeState = source.type === 'pull-request' ? source.mergeState : undefined;
  const isTerminalMergeState = sourceMergeState
    ? isTerminalPullRequestMergeState(sourceMergeState)
    : false;
  const sourceMergeStatusBadge =
    sourceMergeState && isTerminalMergeState ? (
      <PullRequestMergeStatusBadge mergeState={sourceMergeState} />
    ) : null;
  const sourceDescriptionActions =
    interactive && source.type === 'pull-request' ? (
      <PullRequestReviewButtons
        disabled={pullRequestReviewSubmitting != null || pullRequestCloseSubmitting}
        hasPendingComments={
          getPendingPullRequestReviewComments(localReviewComments, activeReviewCommentDraftState)
            .length > 0
        }
        onClosePullRequest={closePullRequest}
        onSubmitReview={submitReview}
        reviewStatus={source.reviewStatus}
        showCommentReview={source.provider === 'github' || source.host === 'github.com'}
      >
        {sourceMergeStatusBadge}
      </PullRequestReviewButtons>
    ) : sourceMergeStatusBadge ? (
      <div aria-label="Pull request status" className="source-description-review-actions">
        {sourceMergeStatusBadge}
      </div>
    ) : undefined;
  const sourceDescriptionFooterMain =
    interactive && sourceMergeState && !isTerminalMergeState ? (
      <PullRequestMergeControls
        disabled={pullRequestMergeSubmitting}
        isPending={pullRequestMergeSubmitting}
        mergeState={sourceMergeState}
        onCancelAutoMerge={cancelAutoMerge}
        onMergePullRequest={mergePullRequest}
      />
    ) : undefined;
  const sourceDescription =
    source.type === 'pull-request' ? (
      <PullRequestSourceDescription
        actions={sourceDescriptionActions}
        footer={sourceDescriptionFooterMain}
        footerAside={sourceDescriptionFooterAside}
        keymap={keymap}
        onUpdateDescription={interactive?.onUpdateDescription}
        onUpdateTitle={interactive?.onUpdateTitle}
        onUploadDescriptionAsset={interactive?.onUploadDescriptionAsset}
        source={source}
      />
    ) : null;

  const renderWalkthroughDiffBlocks = (
    blocks: ReadonlyArray<ReviewDiffBlock>,
    blockScrollTarget: WalkthroughBlockScrollTarget | null,
    onActiveBlockChange: (blockId: string) => void,
  ) => {
    return (
      <div className="wt-stop wt-diff-surface">
        <ReviewCodeView
          {...commonReviewProps}
          allowViewedToggle
          blocks={blocks}
          bottomInset={walkthroughCodeViewBottomInset}
          files={[]}
          forceExpandedPaths={new Set()}
          onActiveBlockChange={onActiveBlockChange}
          scrollTarget={blockScrollTarget}
          selectedPath={null}
          sourceDescriptionActions={sourceDescriptionActions}
          sourceDescriptionFooter={sourceDescriptionFooterMain}
          sourceDescriptionFooterAside={sourceDescriptionFooterAside}
          walkthroughNotes={emptyWalkthroughNotes}
        />
      </div>
    );
  };

  const sourceLabel =
    snapshot.repository.source.type === 'working-tree'
      ? null
      : getSourceLabel(snapshot.repository.source);
  const rootLabel = repositoryUrl
    ? snapshot.repository.root
    : compactPath(snapshot.repository.root);
  const sourceExternalUrl =
    snapshot.repository.source.type === 'pull-request'
      ? (externalUrl ?? snapshot.repository.source.url)
      : null;
  const repositoryLinkUrl = repositoryUrl ?? sourceExternalUrl;
  const gitLabProjectUrl = externalUrl?.split('/-/merge_requests/')[0];
  const versionCompareFrom =
    versions.find((version) => version.id === versionCompareFromId) ?? versionCompare?.from;
  const versionCompareTo =
    versions.find((version) => version.id === versionCompareToId) ?? versionCompare?.to;
  const diffScopeSummary = versionCompareActive ? (
    versionCompareFrom && versionCompareTo ? (
      <>
        <VersionComparisonEndpoint
          gitLabProjectUrl={gitLabProjectUrl}
          version={versionCompareFrom}
        />
        {' → '}
        <VersionComparisonEndpoint gitLabProjectUrl={gitLabProjectUrl} version={versionCompareTo} />
      </>
    ) : (
      <span>Choose versions</span>
    )
  ) : null;
  const selectVersionComparisonScope = () => {
    if (versionCompareActive) {
      return;
    }
    setActiveCommitSha(null);
    setCommitDiffError(null);
    setSelectedTreeCommitShas(new Set());
    setTreeCommitDiffError(null);
    setVersionSectionExpanded(true);
    interactive?.onOpenVersionCompare?.();
  };
  const walkthroughStatus =
    walkthroughRequestPending && interactive?.walkthroughStatus !== 'ready'
      ? 'generating'
      : interactive?.walkthroughStatus;
  const [walkthroughProgressRevision, setWalkthroughProgressRevision] = useState(0);
  const previousWalkthroughStatusRef = useRef(walkthroughStatus);
  useEffect(() => {
    if (
      walkthroughStatus === 'generating' &&
      previousWalkthroughStatusRef.current !== 'generating'
    ) {
      setWalkthroughProgressRevision((current) => current + 1);
    }
    previousWalkthroughStatusRef.current = walkthroughStatus;
  }, [walkthroughStatus]);
  const walkthroughReady = !interactive || walkthroughStatus === 'ready';
  const versionWalkthroughFilesMissing =
    walkthroughReady &&
    Boolean(versionCompare) &&
    versionWalkthroughStructure === 'commit-by-commit' &&
    !legacyWalkthroughNeedsCommitDiffs &&
    walkthroughFiles.length === 0;
  const legacyWalkthroughDiffLoading =
    walkthroughReady &&
    legacyWalkthroughNeedsCommitDiffs &&
    missingWalkthroughCommitShas.length > 0 &&
    commitDiffLoading;
  const legacyWalkthroughDiffError =
    walkthroughReady &&
    legacyWalkthroughNeedsCommitDiffs &&
    missingWalkthroughCommitShas.length > 0 &&
    commitDiffError;
  const walkthroughFailed = walkthroughStatus === 'failed';
  const walkthroughIdle = walkthroughStatus === 'idle';
  const baselineWalkthroughStructure =
    baselineWalkthroughStructureOverride ?? interactive?.reviewStrategy?.mode ?? 'whole-diff';
  const walkthroughStructurePhrase = versionCompareActive
    ? versionWalkthroughStructure === 'commit-by-commit'
      ? 'commit-by-commit version'
      : 'whole-diff version'
    : baselineWalkthroughStructure === 'commit-by-commit'
      ? 'commit-by-commit'
      : 'whole-diff';
  const computingVersionChanges = Boolean(versionCompareLoading);
  const walkthroughBusy = walkthroughRequestPending || walkthroughStatus === 'generating';
  // Non-forced in-flight requests are either a cache lookup or the brief handoff before
  // the server flips to generating. Forced rebuilds / active generation use generate copy.
  const loadingWalkthroughLookup =
    walkthroughBusy && !walkthroughRequestForce && walkthroughStatus !== 'generating';
  const generatingWalkthrough =
    walkthroughBusy && (walkthroughRequestForce || walkthroughStatus === 'generating');
  const walkthroughGenerationProgress = interactive?.walkthroughProgress ?? null;
  const walkthroughStatusTitle = walkthroughFailed
    ? 'Walkthrough unavailable'
    : computingVersionChanges
      ? 'Computing version changes…'
      : walkthroughIdle && !walkthroughBusy
        ? 'Walkthrough not generated'
        : loadingWalkthroughLookup
          ? 'Loading walkthrough…'
          : 'Generating walkthrough…';
  const walkthroughStatusDescription = walkthroughFailed
    ? (interactive?.walkthroughError ?? 'Fix the generation issue, then try again.')
    : computingVersionChanges
      ? 'Comparing the selected versions and preparing the review surface.'
      : walkthroughIdle && !walkthroughBusy
        ? versionCompareActive
          ? 'Choose a walkthrough structure, then generate it for this version comparison.'
          : 'Generate a walkthrough to review these changes.'
        : (walkthroughGenerationProgress?.summary ??
          interactive?.walkthroughError ??
          (loadingWalkthroughLookup
            ? `Looking up a cached ${walkthroughStructurePhrase} walkthrough.`
            : null));
  const walkthroughProgressLabel = computingVersionChanges
    ? 'Computing version changes…'
    : loadingWalkthroughLookup
      ? 'Loading walkthrough…'
      : generatingWalkthrough
        ? 'Generating walkthrough…'
        : undefined;
  const shellTheme =
    snapshot.preferences.theme === 'system' ? undefined : snapshot.preferences.theme;
  const requestWalkthrough = (options?: {
    force?: boolean;
    reviewStructure?: 'commit-by-commit' | 'whole-diff';
    unitId?: string;
    versionCompare?: {
      fromId: string;
      toId: string;
      walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
    };
  }) => {
    startWalkthroughGeneration(options);
  };
  const alternateReviewStructure =
    baselineWalkthroughStructure === 'commit-by-commit' ? 'whole-diff' : 'commit-by-commit';
  const showCommentsTab = Boolean(commenting || interactive || generalCommentCount > 0);
  const reviewModes = [
    {
      icon: <Path aria-hidden size={14} weight="bold" />,
      label: 'Walkthrough',
      value: 'walkthrough',
    },
    {
      icon: <TreeStructure aria-hidden size={14} weight="bold" />,
      label: 'Tree',
      value: 'tree',
    },
    ...(showCommentsTab
      ? [
          {
            ariaLabel: generalCommentCount > 0 ? `Comments (${generalCommentCount})` : 'Comments',
            icon: <ChatCircle aria-hidden size={14} weight="bold" />,
            indicator:
              generalCommentCount > 0 ? (
                <span aria-hidden className="review-mode-count">
                  {generalCommentCount}
                </span>
              ) : undefined,
            label: 'Comments',
            title:
              generalCommentCount > 0
                ? `${generalCommentCount} ${generalCommentCount === 1 ? 'comment' : 'comments'}`
                : 'Comments',
            value: 'comments' as const,
          },
        ]
      : []),
  ] satisfies ReadonlyArray<ReviewModeItem<ReviewMode>>;
  const topBarActions =
    onDeleteShare || settingsBar ? (
      <>
        {onDeleteShare ? (
          <Button
            action={deleteShare}
            aria-label="Delete shared walkthrough"
            pendingPlaceholder="…"
            size="icon"
            title="Delete shared walkthrough"
            type="button"
            variant="destructive"
          >
            <Trash2 aria-hidden size={16} />
          </Button>
        ) : null}
        {settingsBar ? <div className="review-top-bar-settings">{settingsBar}</div> : null}
      </>
    ) : undefined;

  return (
    <div
      className={`app-shell share-shell${interactive ? ' merge-request-shell' : ''}${
        sidebarCollapsed ? ' sidebar-collapsed' : ''
      }`}
      data-theme={shellTheme}
      style={
        sidebarCollapsed ? undefined : { gridTemplateColumns: `${sidebarWidth}px 0 minmax(0, 1fr)` }
      }
    >
      <ReviewTopBar
        actions={topBarActions}
        context={
          <>
            {snapshot.branch ? (
              <span className="review-top-bar-branch" title={snapshot.branch}>
                {snapshot.branch}
              </span>
            ) : null}
            {sourceLabel ? (
              sourceExternalUrl ? (
                <a
                  aria-label={`Open ${sourceLabel} in ${providerLabel}`}
                  className="review-top-bar-source"
                  href={sourceExternalUrl}
                  rel="noreferrer"
                  target="_blank"
                  title={`Open ${sourceLabel} in ${providerLabel}`}
                >
                  <span>{sourceLabel}</span>
                  <ArrowSquareOut aria-hidden size={14} weight="bold" />
                </a>
              ) : (
                <span className="review-top-bar-source">{sourceLabel}</span>
              )
            ) : null}
          </>
        }
        leading={
          interactive ? (
            <button
              aria-label="Back to Codiff"
              className="merge-request-nav-button merge-request-home-button"
              onClick={interactive.onHome}
              title="Back to Codiff"
              type="button"
            >
              <img
                alt=""
                aria-hidden
                className="merge-request-nav-icon"
                draggable={false}
                src="/icon.png"
              />
            </button>
          ) : undefined
        }
        mode={sidebarMode}
        modes={reviewModes}
        onModeChange={changeSidebarMode}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        repository={
          repositoryLinkUrl ? (
            <a
              className="review-top-bar-repository"
              href={repositoryLinkUrl}
              rel="noreferrer"
              target={repositoryUrl ? undefined : '_blank'}
            >
              {rootLabel}
            </a>
          ) : (
            <span className="review-top-bar-repository">{rootLabel}</span>
          )
        }
        repositoryTooltip={snapshot.repository.root}
        sidebarCollapsed={sidebarCollapsed}
        toggleTitle={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar`}
      />
      <aside className="squircle sidebar">
        <div className="sidebar-search-row">
          <input
            aria-label="Filter changed files"
            className="sidebar-search"
            onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
            placeholder="Filter files"
            spellCheck={false}
            type="search"
            value={fileSearchQuery}
          />
        </div>
        {interactive && sidebarMode !== 'comments' ? (
          <div
            className={`history-section version-comparison-section${versionSectionExpanded ? '' : ' collapsed'}`}
          >
            <div className="version-comparison-header">
              {versionCompareActive ? (
                <button
                  aria-controls="version-comparison-body"
                  aria-expanded={versionSectionExpanded}
                  className="version-comparison-toggle"
                  onClick={() => setVersionSectionExpanded((expanded) => !expanded)}
                  type="button"
                >
                  <span aria-hidden className="version-comparison-toggle-caret">
                    {versionSectionExpanded ? '▾' : '▸'}
                  </span>
                  <span className="version-comparison-toggle-copy">
                    <strong>Diff scope</strong>
                    <span className="version-comparison-summary">{diffScopeSummary}</span>
                  </span>
                </button>
              ) : (
                <span className="version-comparison-toggle-copy">
                  <strong>Diff scope</strong>
                </span>
              )}
              <div aria-label="Diff scope" className="diff-scope-control" role="group">
                <button
                  aria-pressed={!versionCompareActive}
                  className={!versionCompareActive ? 'selected' : ''}
                  disabled={!versionCompareActive}
                  onClick={() => interactive.onExitVersionCompare?.()}
                  type="button"
                >
                  {wholeDiffLabel}
                </button>
                <button
                  aria-pressed={versionCompareActive}
                  className={versionCompareActive ? 'selected' : ''}
                  disabled={!interactive.onOpenVersionCompare || versionCompareActive}
                  onClick={selectVersionComparisonScope}
                  type="button"
                >
                  {versionHistoryLabel === 'Head history' ? 'Compare heads' : 'Compare versions'}
                </button>
              </div>
            </div>
            {!versionCompareActive && versionHistoryWarning ? (
              <div className="version-comparison-status">{versionHistoryWarning}</div>
            ) : null}
            {versionSectionExpanded && versionCompareActive ? (
              <div className="version-comparison-body" id="version-comparison-body">
                {versionHistoryLoading ? (
                  <div aria-live="polite" className="version-comparison-status" role="status">
                    <span aria-hidden className="version-comparison-spinner" />
                    {`Loading ${versionHistoryLabel.toLowerCase()}…`}
                  </div>
                ) : versions.length >= 2 && interactive?.onVersionCompareRangeChange ? (
                  <div className="version-picker-pair">
                    <VersionPicker
                      gitLabProjectUrl={gitLabProjectUrl}
                      label="From"
                      onChange={(fromId) =>
                        interactive.onVersionCompareRangeChange?.(
                          fromId,
                          versionCompareToId ?? versions[0]?.id ?? '',
                        )
                      }
                      otherId={versionCompareToId}
                      value={versionCompareFromId ?? versions[1]?.id ?? versions[0]?.id ?? ''}
                      versions={versions}
                    />
                    <VersionPicker
                      gitLabProjectUrl={gitLabProjectUrl}
                      label="To"
                      onChange={(toId) =>
                        interactive.onVersionCompareRangeChange?.(
                          versionCompareFromId ?? versions[1]?.id ?? '',
                          toId,
                        )
                      }
                      otherId={versionCompareFromId}
                      value={versionCompareToId ?? versions[0]?.id ?? ''}
                      versions={versions}
                    />
                  </div>
                ) : null}
                {versionCompare?.analysis.baseMovement?.changed &&
                versionCompare.analysis.baseMovement ? (
                  <div className="version-base-movement" role="status">
                    <div>
                      <strong>Base changed</strong>{' '}
                      <CommitRefTooltip
                        commit={{
                          authoredAt: versionCompare.analysis.baseMovement.from.committedAt,
                          sha: versionCompare.analysis.baseMovement.from.sha,
                          shortSha: versionCompare.analysis.baseMovement.from.shortSha,
                          subject: 'Earlier target base',
                          webUrl: versionCompare.analysis.baseMovement.from.webUrl,
                        }}
                      />{' '}
                      →{' '}
                      <CommitRefTooltip
                        commit={{
                          authoredAt: versionCompare.analysis.baseMovement.to.committedAt,
                          sha: versionCompare.analysis.baseMovement.to.sha,
                          shortSha: versionCompare.analysis.baseMovement.to.shortSha,
                          subject: 'Later target base',
                          webUrl: versionCompare.analysis.baseMovement.to.webUrl,
                        }}
                      />
                    </div>
                    {versionCompare.analysis.baseMovement.diffStat ? (
                      <div className="version-base-movement-stat">
                        {formatBaseMovementCommitCount(versionCompare.analysis.baseMovement)}
                        {' · '}
                        {versionCompare.analysis.baseMovement.diffStat.filesChanged} files
                        {' · '}
                        <span className="diffstat-additions">
                          +{versionCompare.analysis.baseMovement.diffStat.additions}
                        </span>{' '}
                        <span className="diffstat-deletions">
                          −{versionCompare.analysis.baseMovement.diffStat.deletions}
                        </span>
                        {' · '}
                        {formatBaseMovementRelationship(
                          versionCompare.analysis.baseMovement.relationship,
                        )}
                        {formatSignedBaseInterval(
                          versionCompare.analysis.baseMovement.commitTimestampDeltaMs,
                        )
                          ? ` · ${formatSignedBaseInterval(versionCompare.analysis.baseMovement.commitTimestampDeltaMs)}`
                          : ''}
                      </div>
                    ) : (
                      <div className="version-base-movement-stat">Details unavailable</div>
                    )}
                    {(versionCompare.analysis.baseMovement.commits?.length ?? 0) > 0 ? (
                      <details className="version-base-movement-commits">
                        <summary>
                          {versionCompare.analysis.baseMovement.relationship === 'backward'
                            ? 'Show previous base commits'
                            : 'Show new base commits'}{' '}
                          ({formatBaseMovementCommitCount(versionCompare.analysis.baseMovement)})
                        </summary>
                        <div className="version-commit-evolution-list version-base-movement-commit-list">
                          {(versionCompare.analysis.baseMovement.commits ?? []).map((commit) => {
                            const isBackward =
                              versionCompare.analysis.baseMovement?.relationship === 'backward';
                            return (
                              <div
                                className="version-commit-unit version-base-movement-commit"
                                key={commit.sha}
                              >
                                <span
                                  className={`version-commit-kind-pill ${isBackward ? 'removed' : 'introduced'}`}
                                >
                                  {isBackward ? 'Removed' : 'Added'}
                                </span>
                                <CommitRefTooltip commit={commit} />
                                <span>{commit.subject}</span>
                              </div>
                            );
                          })}
                        </div>
                        {versionCompare.analysis.baseMovement.truncated ? (
                          <small>Commit list may be truncated by GitLab compare limits.</small>
                        ) : null}
                      </details>
                    ) : null}
                    {versionCompare.analysis.baseMovement.warning ? (
                      <small>{versionCompare.analysis.baseMovement.warning}</small>
                    ) : null}
                    <small>
                      Base branch changes are context only and are excluded from this review.
                    </small>
                  </div>
                ) : null}
                {versionCompareLoading ? (
                  <div aria-live="polite" className="version-comparison-status" role="status">
                    <span aria-hidden className="version-comparison-spinner" />
                    Computing changes between versions…
                  </div>
                ) : null}
                {versionCompareError ? (
                  <div className="version-comparison-status error">{versionCompareError}</div>
                ) : null}
                {versionCommitEvolutionLoading ? (
                  <div aria-live="polite" className="version-comparison-status" role="status">
                    <span aria-hidden className="version-comparison-spinner" />
                    Analyzing commit evolution…
                  </div>
                ) : null}
                {versionCommitEvolutionError ? (
                  <details className="version-comparison-status error">
                    <summary>Commit evolution could not be analyzed</summary>
                    <small>{versionCommitEvolutionError}</small>
                  </details>
                ) : null}
                {versionCommitEvolution ? (
                  <div className="version-commit-evolution">
                    <strong>Commit stack</strong>
                    <div className="version-commit-evolution-list">
                      {versionCommitEvolution.warnings?.map((warning) => (
                        <div className="version-commit-warning" key={warning}>
                          {warning}
                        </div>
                      ))}
                      {versionCommitEvolution.units.map((unit) => {
                        const commit = evolutionUnitCommit(unit);
                        if (!commit) {
                          return null;
                        }
                        const isUnchanged =
                          unit.kind === 'retained' ||
                          unit.kind === 'rewritten-same-patch' ||
                          unit.kind === 'absorbed-into-base';
                        const versionCommitKind =
                          unit.kind !== 'commit' &&
                          'after' in unit &&
                          unit.after?.sha === commit.sha
                            ? unit.kind
                            : undefined;
                        const kindClass =
                          unit.kind === 'absorbed-into-base'
                            ? 'absorbed-into-base'
                            : isUnchanged
                              ? 'unchanged'
                              : unit.kind;
                        const walkthroughChapter = navigation.walkthroughView?.chapters.find(
                          (chapter) => chapter.commit?.sha === unit.id,
                        );
                        const walkthroughStopIndex = walkthroughChapter?.stops[0]?.index;
                        const canNavigate = walkthroughStopIndex != null;
                        const rebaseDrivers = evolutionUnitRebaseDrivers(unit);
                        const driverTitle =
                          rebaseDrivers.length > 0
                            ? `Likely rebase drivers: ${rebaseDrivers
                                .map((driver) => `${driver.shortSha} ${driver.subject}`)
                                .join('; ')}`
                            : null;
                        return (
                          <div className="version-commit-unit-block" key={unit.id}>
                            <button
                              aria-pressed={selectedVersionUnitIds.has(unit.id)}
                              className={`version-commit-unit ${kindClass}`}
                              disabled={!unit.reviewable && !canNavigate}
                              onClick={() => {
                                if (unit.reviewable) {
                                  selectOnlyVersionUnit(unit);
                                  changeSidebarMode('tree');
                                } else if (canNavigate) {
                                  changeSidebarMode('walkthrough');
                                  navigation.goStop(walkthroughStopIndex);
                                }
                              }}
                              title={
                                isUnchanged
                                  ? unit.kind === 'absorbed-into-base'
                                    ? `Now in target base${
                                        unit.kind === 'absorbed-into-base' && unit.baseCommit
                                          ? ` as ${unit.baseCommit.shortSha} ${unit.baseCommit.subject}`
                                          : ''
                                      }`
                                    : 'Unchanged between versions'
                                  : unit.kind === 'ambiguous'
                                    ? (('matchReasons' in unit
                                        ? unit.matchReasons?.[0]
                                        : undefined) ?? 'Unable to classify')
                                    : (driverTitle ??
                                      `${unit.kind === 'revised' ? 'Revised' : unit.kind === 'introduced' ? 'Added' : 'Removed'} between versions`)
                              }
                              type="button"
                            >
                              <span className={`version-commit-kind-pill ${kindClass}`}>
                                {unit.kind === 'commit'
                                  ? 'Commit'
                                  : versionCommitKindLabel(unit.kind)}
                              </span>
                              <CommitRefTooltip
                                commit={{
                                  additions: commit.diffStat?.additions,
                                  authoredAt: commit.authoredAt,
                                  authorName: commit.authorName,
                                  deletions: commit.diffStat?.deletions,
                                  sha: commit.sha,
                                  shortSha: commit.shortSha,
                                  subject: commit.subject,
                                  versionCommitKind,
                                  webUrl: commit.webUrl,
                                }}
                                focusable={false}
                                linkTrigger={false}
                              />
                              <span>{commit.subject}</span>
                            </button>
                            {rebaseDrivers.length > 0 ? (
                              <div className="version-commit-rebase-drivers">
                                <span className="version-commit-rebase-drivers-label">
                                  Rebase pressure
                                </span>
                                {rebaseDrivers.map((driver) => (
                                  <div
                                    className="version-commit-unit version-base-movement-commit"
                                    key={`${unit.id}:${driver.sha}`}
                                  >
                                    <span className="version-commit-kind-pill likely-revised">
                                      Rebase driver
                                    </span>
                                    <CommitRefTooltip
                                      commit={{
                                        authoredAt: driver.authoredAt,
                                        authorName: driver.authorName,
                                        sha: driver.sha,
                                        shortSha: driver.shortSha,
                                        subject: driver.subject,
                                        webUrl: driver.webUrl,
                                      }}
                                    />
                                    <span>{driver.subject}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {selectedVersionUnits.length > 0 ? (
                  <div className="version-unit-scope">
                    <span>
                      Viewing {selectedVersionUnits.length}{' '}
                      {selectedVersionUnits.length === 1 ? 'commit change' : 'commit changes'}
                    </span>
                    <button onClick={clearVersionUnits} type="button">
                      All version changes
                    </button>
                  </div>
                ) : null}
                {versionCompare && !versionCompare.analysis.summary.empty ? (
                  <div className="version-walkthrough-structure">
                    <strong>Walkthrough structure</strong>
                    <label>
                      <input
                        checked={versionWalkthroughStructure === 'commit-by-commit'}
                        disabled={!versionCommitEvolution}
                        name="version-walkthrough-structure"
                        onChange={() => setVersionWalkthroughStructure('commit-by-commit')}
                        type="radio"
                      />
                      Commit-by-commit
                      {versionCommitEvolution?.recommendation.suggestedStructure ===
                      'commit-by-commit'
                        ? ' — Recommended'
                        : ''}
                    </label>
                    <label>
                      <input
                        checked={versionWalkthroughStructure === 'whole-diff'}
                        name="version-walkthrough-structure"
                        onChange={() => setVersionWalkthroughStructure('whole-diff')}
                        type="radio"
                      />
                      Whole diff
                      {versionCommitEvolution?.recommendation.suggestedStructure === 'whole-diff'
                        ? ' — Recommended'
                        : ''}
                    </label>
                    <small>
                      {versionCommitEvolution?.recommendation.rationale ??
                        'Whole diff is available while commit evolution loads.'}
                    </small>
                    <button
                      aria-label={`Generate ${versionWalkthroughStructure === 'commit-by-commit' ? 'commit-by-commit' : 'whole diff'} walkthrough`}
                      className="merge-request-nav-button sidebar-version-compare-button"
                      onClick={() => {
                        requestWalkthrough(versionCompareWalkthroughOptions);
                        setVersionSectionExpanded(false);
                        changeSidebarMode('walkthrough');
                      }}
                      type="button"
                    >
                      Generate{' '}
                      {versionWalkthroughStructure === 'commit-by-commit'
                        ? 'commit-by-commit'
                        : 'whole diff'}{' '}
                      walkthrough
                    </button>
                  </div>
                ) : versionCompare && versionCommitEvolution?.summary.reviewable ? (
                  <div className="version-comparison-status">
                    The final patch is equivalent, but the commit stack changed.
                  </div>
                ) : versionCompare ? (
                  <div className="version-comparison-status">
                    These versions have no intentional MR changes.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {sidebarMode === 'tree' ? (
          <>
            {versionCompareActive ? (
              <CommitScopePanel
                commits={commits}
                mode="version-compare"
                onClear={clearVersionUnits}
                onSelectCommit={() => {}}
                onToggleVersionUnit={toggleVersionUnit}
                selectedVersionUnitIds={selectedVersionUnitIds}
                versionCommitEvolution={versionCommitEvolution}
                versionUnitError={versionUnitError}
                versionUnitLoading={versionUnitLoading}
              />
            ) : null}
            {!versionCompareActive && commits.length > 0 ? (
              <CommitScopePanel
                commits={commits}
                mode="merge-request"
                onClear={() => {
                  setSelectedTreeCommitShas(new Set());
                  setTreeCommitDiffError(null);
                  setSelectedPath(snapshot.files[0]?.path ?? null);
                }}
                onSelectCommit={(sha) => {
                  if (!sha) {
                    return;
                  }
                  setSelectedTreeCommitShas((current) => {
                    const next = new Set(current);
                    if (next.has(sha)) {
                      next.delete(sha);
                    } else {
                      next.add(sha);
                    }
                    return next;
                  });
                  setTreeCommitDiffError(null);
                }}
                selectedCommitShas={selectedTreeCommitShas}
              />
            ) : null}
            {treeCommitDiffLoading && selectedTreeCommitShas.size > 0 ? (
              <div className="sidebar-scope-status">Loading selected commit changes…</div>
            ) : treeCommitDiffError ? (
              <div className="sidebar-scope-status error">{treeCommitDiffError}</div>
            ) : (
              <SharedFileTree
                files={visibleFiles}
                key={
                  versionCompareActive
                    ? `version:${[...selectedVersionUnitIds].join(',') || 'all'}`
                    : `commits:${[...selectedTreeCommitShas].join(',') || 'all'}`
                }
                onActivatePath={activateTreePath}
                selectedPath={visibleSelectedPath}
                showWhitespace={snapshot.preferences.showWhitespace}
              />
            )}
          </>
        ) : sidebarMode === 'commits' ? (
          <div className="history-list sidebar-comment-list">
            {interactive?.reviewStrategy ? (
              <div className="history-section">
                {interactive.reviewStrategy.mode === 'commit-by-commit'
                  ? 'Structured by commits'
                  : `${wholeDiffLabel} (${interactive.reviewStrategy.reason})`}
              </div>
            ) : null}
            {commits.map((commit) => {
              const selected = commit.sha === activeCommitSha;
              return (
                <button
                  className={`history-entry sidebar-comment-entry with-metadata${selected ? ' selected' : ''}`}
                  key={commit.sha}
                  onClick={() => selectCommit(commit.sha)}
                  title={commit.subject}
                  type="button"
                >
                  <span className="history-entry-ref">
                    <CommitRefTooltip
                      commit={{
                        authoredAt: commit.authoredAt,
                        authorName: commit.authorName,
                        sha: commit.sha,
                        shortSha: getShortRef(commit.shortSha || commit.sha),
                        subject: commit.subject,
                        webUrl: commit.webUrl,
                      }}
                      focusable={false}
                      linkTrigger={false}
                    />
                  </span>
                  <span className="history-entry-subject">{commit.subject}</span>
                  <span className="history-entry-meta">
                    <span className="history-entry-author">
                      <span>{commit.authorName}</span>
                      {commit.role ? <span>· {commit.role}</span> : null}
                    </span>
                    <span>{shortRelativeTime(commit.authoredAt)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : sidebarMode === 'comments' ? (
          <>
            <div className="sidebar-comments-preferences">
              <button
                className="review-comment-action"
                onClick={() => setShowResolvedComments((value) => !value)}
                type="button"
              >
                {showResolvedComments ? 'Hide resolved' : 'Show resolved'}
              </button>
            </div>
            <SidebarCommentSection
              count={overviewComments.length + aiReviews.length}
              title="Overview comments"
            >
              <AIReviewDrawer
                commentsError={commentsError}
                commentsLoading={commentsLoading}
                onSelectReview={setSelectedAIReviewId}
                reviews={orderedAIReviews}
                selectedReviewId={selectedAIReviewId}
              />
              {overviewComments.length > 0 ? (
                <SidebarOverviewCommentList
                  comments={overviewComments}
                  focusedCommentId={focusedGeneralCommentId}
                  onActivateComment={activateGeneralComment}
                />
              ) : !commentsLoading && aiReviews.length === 0 ? (
                <div className="sidebar-comments-empty">No overview comments.</div>
              ) : null}
            </SidebarCommentSection>
            <SidebarCommentSection count={sidebarCodeComments.length} title="Code comments">
              <SidebarCodeCommentList
                commentAssociations={commentAssociationById}
                comments={sidebarCodeComments}
                focusedCommentId={focusCommentId}
                onActivateComment={activateReviewComment}
                onOpenVersionCompareForComment={(commentId) =>
                  interactive?.onOpenVersionCompare?.({ commentId })
                }
              />
            </SidebarCommentSection>
          </>
        ) : walkthroughReady ? (
          <>
            {!versionCompareActive && interactive?.reviewStrategy ? (
              <div className="history-section walkthrough-structure-controls">
                <span>
                  {baselineWalkthroughStructure === 'commit-by-commit'
                    ? 'Structured by commits'
                    : `${wholeDiffLabel} (${interactive.reviewStrategy.reason})`}
                </span>
                <button
                  aria-label={
                    alternateReviewStructure === 'whole-diff'
                      ? 'Generate whole merge request walkthrough'
                      : 'Generate commit-by-commit walkthrough'
                  }
                  className="merge-request-nav-button"
                  disabled={walkthroughStatus === 'generating' || walkthroughRequestPending}
                  onClick={() =>
                    requestWalkthrough({
                      force: true,
                      reviewStructure: alternateReviewStructure,
                    })
                  }
                  type="button"
                >
                  {alternateReviewStructure === 'whole-diff'
                    ? 'Use whole-MR walkthrough'
                    : 'Use commit-by-commit walkthrough'}
                </button>
              </div>
            ) : null}
            <NarrativeSidebar
              allowCommit={false}
              changedPaths={
                versionCompareChangedPaths.size > 0 ? versionCompareChangedPaths : undefined
              }
              commitEvolutionKinds={
                versionCommitEvolution
                  ? new Map(versionCommitEvolution.units.map((unit) => [unit.id, unit.kind]))
                  : undefined
              }
              files={visibleFiles}
              navigation={navigation}
              onRegenerateWalkthrough={
                versionCompareActive && versionCompareWalkthroughOptions
                  ? () =>
                      requestWalkthrough({
                        ...versionCompareWalkthroughOptions,
                        force: true,
                      })
                  : interactive?.reviewStrategy
                    ? () =>
                        requestWalkthrough({
                          force: true,
                          reviewStructure:
                            baselineWalkthroughStructure === 'commit-by-commit'
                              ? 'commit-by-commit'
                              : 'whole-diff',
                        })
                    : () => requestWalkthrough({ force: true })
              }
              showWhitespace={snapshot.preferences.showWhitespace}
              walkthrough={sharedWalkthrough}
            />
          </>
        ) : (
          <div className="sidebar-walkthrough-status-shell">
            <div className="sidebar-walkthrough-status-stack">
              {walkthroughBusy && !versionCompareActive && interactive?.reviewStrategy ? (
                <div className="walkthrough-generation-structure">
                  <strong>
                    Generating ·{' '}
                    {baselineWalkthroughStructure === 'commit-by-commit'
                      ? 'Commit-by-commit'
                      : wholeDiffLabel}
                  </strong>
                  <button
                    onClick={() =>
                      requestWalkthrough({
                        force: true,
                        reviewStructure: alternateReviewStructure,
                      })
                    }
                    type="button"
                  >
                    Switch to{' '}
                    {alternateReviewStructure === 'commit-by-commit'
                      ? 'commit-by-commit'
                      : wholeDiffLabel}
                  </button>
                  {queuedReviewStructure ? (
                    <small>
                      Queued:{' '}
                      {queuedReviewStructure === 'commit-by-commit'
                        ? 'commit-by-commit'
                        : wholeDiffLabel}
                    </small>
                  ) : null}
                </div>
              ) : null}
              <div
                className={`sidebar-walkthrough-status${walkthroughStatus === 'generating' ? ' codex' : ''}`}
                title={walkthroughStatusDescription ?? undefined}
              >
                {walkthroughFailed ||
                (walkthroughIdle && !walkthroughBusy && !computingVersionChanges) ? (
                  <>
                    <strong>{walkthroughStatusTitle}</strong>
                    {walkthroughStatusDescription ? (
                      <span>{walkthroughStatusDescription}</span>
                    ) : null}
                  </>
                ) : (
                  <WalkthroughProgress
                    detail={walkthroughStatusDescription}
                    label={walkthroughProgressLabel}
                    phase={null}
                    progress={walkthroughGenerationProgress}
                    responseLabelIndex={0}
                    stageRevision={walkthroughProgressRevision}
                  />
                )}
              </div>
            </div>
          </div>
        )}
        {showTotalLineCount ? (
          <div className="sidebar-settings-bar">
            <DiffLineCountBadge
              ariaLabelPrefix="Total change"
              className="sidebar-total-line-count sidebar-settings-line-count"
              lineCount={totalLineCount}
            />
          </div>
        ) : null}
      </aside>
      <div aria-hidden className="sidebar-resizer" onPointerDown={resizeSidebar} />
      <main className="review codiff-web-review">
        {sidebarMode === 'comments' ? (
          <MergeRequestCommentsView
            aiReview={selectedAIReview}
            canComment={canComment}
            commenting={commenting}
            commentsError={commentsError}
            commentsLoading={commentsLoading}
            draft={generalCommentDraft}
            editDraft={generalCommentEditDraft}
            editError={generalCommentEditError}
            editingCommentId={editingGeneralCommentId}
            editSubmitting={generalCommentEditSubmitting}
            error={generalCommentError}
            focusedCommentId={focusedGeneralCommentId}
            focusedCommentRequest={generalCommentScrollRequest}
            gitIdentity={gitIdentity}
            keymap={keymap}
            onCancelEdit={cancelEditGeneralComment}
            onChangeDraft={setGeneralCommentDraft}
            onChangeEditDraft={setGeneralCommentEditDraft}
            onSaveEdit={saveGeneralCommentEdit}
            onStartEdit={startEditGeneralComment}
            onSubmit={submitGeneralComment}
            sourceDescription={sourceDescription}
            submitting={generalCommentSubmitting}
            threads={generalCommentThreads}
          />
        ) : sidebarMode === 'commits' ? (
          commitDiffLoading && !activeCommitFiles ? (
            <div className="loading codex italic">Loading commit diff…</div>
          ) : commitDiffError ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>Unable to load commit</strong>
                <p>{commitDiffError}</p>
              </div>
            </div>
          ) : visibleFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>{activeCommit ? activeCommit.subject : 'Select a commit'}</strong>
                <span>
                  {activeCommit
                    ? 'This commit has no loadable text diffs.'
                    : 'Choose a commit from the sidebar.'}
                </span>
                <div className="empty-panel-actions">
                  <button onClick={() => changeSidebarMode('tree')} type="button">
                    View whole MR
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="merge-request-nav-row" style={{ padding: '8px 12px' }}>
                <strong>{activeCommit ? activeCommit.subject : 'Commit'}</strong>
                <span style={{ marginLeft: 8, opacity: 0.7 }}>
                  {activeCommit ? (
                    <CommitRefTooltip
                      commit={{
                        authoredAt: activeCommit.authoredAt,
                        authorName: activeCommit.authorName,
                        sha: activeCommit.sha,
                        shortSha: getShortRef(activeCommit.shortSha || activeCommit.sha),
                        subject: activeCommit.subject,
                        webUrl: activeCommit.webUrl,
                      }}
                    />
                  ) : null}
                </span>
                <button
                  className="merge-request-nav-button"
                  onClick={() => changeSidebarMode('tree')}
                  style={{ marginLeft: 'auto' }}
                  type="button"
                >
                  View whole MR
                </button>
              </div>
              <ReviewCodeView
                {...commonReviewProps}
                allowViewedToggle={false}
                files={visibleFiles}
                forceExpandedPaths={emptyPaths}
                isReadOnly
                onSelectPathFromScroll={updateSelectedPathFromScroll}
                scrollTarget={treeScrollTarget}
                selectedPath={visibleSelectedPath}
                sourceDescriptionActions={undefined}
                sourceDescriptionFooter={
                  <div className="empty-panel">
                    Comments are on the full MR diff.
                    <button onClick={() => changeSidebarMode('tree')} type="button">
                      Jump to whole MR
                    </button>
                  </div>
                }
                walkthroughNotes={emptyWalkthroughNotes}
              />
            </>
          )
        ) : sidebarMode === 'tree' ? (
          computingVersionChanges ? (
            <div className="loading codex italic walkthrough-generating-main">
              <WalkthroughProgress
                detail="Comparing the selected versions and preparing the review surface."
                label="Computing version changes…"
                phase={null}
                progress={walkthroughGenerationProgress}
                responseLabelIndex={0}
                stageRevision={walkthroughProgressRevision}
              />
            </div>
          ) : versionCompareActive &&
            selectedVersionUnitIds.size > 0 &&
            versionUnitLoading &&
            selectedVersionUnitFiles.length === 0 ? (
            <div className="loading codex italic">Loading selected commit changes…</div>
          ) : versionCompareActive &&
            selectedVersionUnitIds.size > 0 &&
            versionUnitError &&
            selectedVersionUnitFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>Unable to load selected commit changes</strong>
                <p>{versionUnitError}</p>
              </div>
            </div>
          ) : treeCommitDiffLoading &&
            selectedTreeCommitShas.size > 0 &&
            selectedTreeCommitFiles.length === 0 ? (
            <div className="loading codex italic">Loading selected commit changes…</div>
          ) : treeCommitDiffError ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>Unable to load selected commit changes</strong>
                <p>{treeCommitDiffError}</p>
              </div>
            </div>
          ) : visibleFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-panel squircle">
                <strong>{fileSearchQuery ? 'No matching files' : 'No files in this diff'}</strong>
                {fileSearchQuery ? <span>{fileSearchQuery}</span> : null}
              </div>
            </div>
          ) : (
            <ReviewCodeView
              {...commonReviewProps}
              allowViewedToggle
              files={visibleFiles}
              forceExpandedPaths={emptyPaths}
              key={
                versionCompareActive
                  ? `version:${selectedVersionUnits.map((unit) => unit.id).join(',') || 'all'}`
                  : `commits:${[...selectedTreeCommitShas].join(',') || 'all'}`
              }
              onSelectPathFromScroll={updateSelectedPathFromScroll}
              scrollTarget={treeScrollTarget}
              selectedPath={visibleSelectedPath}
              sourceDescriptionActions={sourceDescriptionActions}
              sourceDescriptionFooter={sourceDescriptionFooterMain}
              sourceDescriptionFooterAside={sourceDescriptionFooterAside}
              walkthroughNotes={emptyWalkthroughNotes}
            />
          )
        ) : versionWalkthroughFilesMissing ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>Commit walkthrough code is unavailable</strong>
              <p>Regenerate this walkthrough to restore its authored commit-unit diff.</p>
              {versionCompareWalkthroughOptions ? (
                <button
                  onClick={() =>
                    requestWalkthrough({
                      ...versionCompareWalkthroughOptions,
                      force: true,
                    })
                  }
                  type="button"
                >
                  Regenerate walkthrough
                </button>
              ) : null}
            </div>
          </div>
        ) : legacyWalkthroughDiffLoading ? (
          <div className="loading codex italic">Loading commit walkthrough code…</div>
        ) : legacyWalkthroughDiffError ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>Unable to load commit walkthrough code</strong>
              <p>{legacyWalkthroughDiffError}</p>
            </div>
          </div>
        ) : walkthroughReady ? (
          <>
            {versionCompare &&
            versionWalkthroughStructure === 'whole-diff' &&
            versionCompare.analysis.baseMovement?.changed &&
            versionCompare.analysis.baseMovement ? (
              <div className="wt-version-base-context">
                <strong>Target base changed between versions</strong>
                {versionCommitEvolution?.summary.absorbedIntoBase ? (
                  <span>
                    {versionCommitEvolution.summary.absorbedIntoBase}{' '}
                    {versionCommitEvolution.summary.absorbedIntoBase === 1
                      ? 'earlier MR commit is'
                      : 'earlier MR commits are'}{' '}
                    now supplied by the target base.
                  </span>
                ) : (
                  <span>
                    Base movement is context only; this walkthrough covers the remaining MR changes.
                  </span>
                )}
                {(versionCompare.analysis.baseMovement.commits?.length ?? 0) > 0 ? (
                  <details>
                    <summary>Show base commits</summary>
                    <div>
                      {(versionCompare.analysis.baseMovement.commits ?? []).map((commit) => (
                        <div key={commit.sha}>
                          <CommitRefTooltip commit={commit} />
                          <span>{commit.subject}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null}
            <NarrativeWalkthroughView
              allowCommit={false}
              changedPaths={
                versionCompareChangedPaths.size > 0 ? versionCompareChangedPaths : undefined
              }
              files={walkthroughFiles}
              navigation={navigation}
              onActiveReviewTargetChange={noop}
              onCommit={disabledCommit}
              onUpdateCommitMessage={disabledCommitMessage}
              renderDiffBlocks={renderWalkthroughDiffBlocks}
              showWhitespace={snapshot.preferences.showWhitespace}
              walkthrough={sharedWalkthrough}
            />
          </>
        ) : computingVersionChanges || walkthroughBusy ? (
          <div className="loading codex italic walkthrough-generating-main">
            <WalkthroughProgress
              detail={walkthroughStatusDescription}
              label={walkthroughProgressLabel ?? walkthroughStatusTitle}
              phase={null}
              progress={walkthroughGenerationProgress}
              responseLabelIndex={0}
              stageRevision={walkthroughProgressRevision}
            />
          </div>
        ) : walkthroughFailed ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{walkthroughStatusTitle}</strong>
              <p>{walkthroughStatusDescription}</p>
              <div className="empty-panel-actions">
                <button
                  onClick={() => requestWalkthrough(versionCompareWalkthroughOptions)}
                  type="button"
                >
                  Try again
                </button>
                {!versionCompareActive && interactive?.reviewStrategy ? (
                  <button
                    onClick={() =>
                      requestWalkthrough({ reviewStructure: alternateReviewStructure })
                    }
                    type="button"
                  >
                    {alternateReviewStructure === 'commit-by-commit'
                      ? 'Try commit-by-commit'
                      : 'Try whole MR'}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : walkthroughIdle ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{walkthroughStatusTitle}</strong>
              <p>{walkthroughStatusDescription}</p>
              <div className="empty-panel-actions">
                <button
                  disabled={versionCompareActive && !versionCompareWalkthroughOptions}
                  onClick={() => requestWalkthrough(versionCompareWalkthroughOptions)}
                  type="button"
                >
                  Generate walkthrough
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export function SharedWalkthroughApp({
  commenting,
  gitIdentity,
  settingsBar,
  snapshot,
}: {
  commenting?: SharedWalkthroughCommenting;
  gitIdentity?: GitIdentity | null;
  settingsBar?: ReactNode;
  snapshot: SharedWalkthroughSnapshot;
}) {
  return (
    <ReviewSurface
      commenting={commenting}
      gitIdentity={gitIdentity}
      settingsBar={settingsBar}
      snapshot={snapshot}
    />
  );
}

export function MergeRequestReviewApp({
  aiReviews,
  commentsError,
  commentsLoading,
  commits,
  externalUrl,
  gitIdentity,
  initialMode,
  onCancelAutoMerge,
  onClosePullRequest,
  onExitVersionCompare,
  onGenerateWalkthrough,
  onHome,
  onLoadCommitDiff,
  onLoadVersionCommitDiff,
  onMergePullRequest,
  onModeChange,
  onOpenVersionCompare,
  onResolveDiscussion,
  onSubmitComment,
  onSubmitGeneralComment,
  onSubmitReview,
  onUpdateComment,
  onUpdateDescription,
  onUpdateGeneralComment,
  onUpdateTitle,
  onUploadDescriptionAsset,
  onVersionCompareRangeChange,
  onVersionWalkthroughStructureChange,
  preferences,
  providerLabel = 'provider',
  reviewStrategy,
  selectedCommitSha,
  settingsBar,
  sourceDescriptionFooterAside,
  state,
  title,
  versionCommitEvolution,
  versionCommitEvolutionError,
  versionCommitEvolutionLoading,
  versionCompare,
  versionCompareEnabled,
  versionCompareError,
  versionCompareFromId,
  versionCompareLoading,
  versionCompareToId,
  versionHistoryLabel = 'Versions',
  versionHistoryLoading,
  versionHistoryWarning,
  versions,
  versionWalkthroughStructure,
  walkthrough,
  walkthroughError,
  walkthroughProgress,
  walkthroughStatus,
  wholeDiffLabel = 'Whole MR',
}: MergeRequestReviewAppProps) {
  const placeholderWalkthrough = useMemo<NarrativeWalkthrough>(
    () => ({
      agent: 'codex',
      chapters: [],
      focus: 'Generate a walkthrough to review this merge request in narrative order.',
      generatedAt: new Date(state.generatedAt).toISOString(),
      kind: 'narrative',
      repo: {
        branch: state.branch,
        root: state.root,
      },
      source: state.source,
      support: [],
      title,
      version: 4,
    }),
    [state.branch, state.generatedAt, state.root, state.source, title],
  );
  const resolvedPreferences = useMemo(
    () => ({
      ...defaultSharedPreferences,
      ...preferences,
    }),
    [preferences],
  );
  const snapshot = useMemo<SharedWalkthroughSnapshot>(
    () => ({
      branch: state.branch,
      codeQualityFindings: state.codeQualityFindings,
      codiffVersion: 'web',
      exportedAt: new Date(state.generatedAt).toISOString(),
      files: state.files,
      kind: 'codiff-walkthrough-share',
      preferences: resolvedPreferences,
      repository: {
        generalComments: state.generalComments,
        root: state.root,
        source: state.source,
        title,
      },
      reviewComments: state.reviewComments,
      version: 1,
      walkthrough: walkthrough ?? placeholderWalkthrough,
    }),
    [placeholderWalkthrough, resolvedPreferences, state, title, walkthrough],
  );

  return (
    <ReviewSurface
      aiReviews={aiReviews}
      commentsError={commentsError}
      commentsLoading={commentsLoading}
      commits={commits}
      externalUrl={externalUrl}
      gitIdentity={gitIdentity}
      initialMode={initialMode}
      interactive={{
        onCancelAutoMerge,
        onClosePullRequest,
        onExitVersionCompare,
        onGenerateWalkthrough,
        onHome,
        onLoadCommitDiff,
        onLoadVersionCommitDiff,
        onMergePullRequest,
        onOpenVersionCompare,
        onResolveDiscussion,
        onSubmitComment,
        onSubmitGeneralComment,
        onSubmitReview,
        onUpdateComment,
        onUpdateDescription,
        onUpdateGeneralComment,
        onUpdateTitle,
        onUploadDescriptionAsset,
        onVersionCompareRangeChange,
        reviewStrategy,
        walkthroughError,
        walkthroughProgress,
        walkthroughStatus,
      }}
      onModeChange={onModeChange}
      onVersionWalkthroughStructureChange={onVersionWalkthroughStructureChange}
      providerLabel={providerLabel}
      selectedCommitSha={selectedCommitSha}
      settingsBar={settingsBar}
      snapshot={snapshot}
      sourceDescriptionFooterAside={sourceDescriptionFooterAside}
      title={title}
      versionCommitEvolution={versionCommitEvolution}
      versionCommitEvolutionError={versionCommitEvolutionError}
      versionCommitEvolutionLoading={versionCommitEvolutionLoading}
      versionCompare={versionCompare}
      versionCompareEnabled={versionCompareEnabled}
      versionCompareError={versionCompareError}
      versionCompareFromId={versionCompareFromId}
      versionCompareLoading={versionCompareLoading}
      versionCompareToId={versionCompareToId}
      versionHistoryLabel={versionHistoryLabel}
      versionHistoryLoading={versionHistoryLoading}
      versionHistoryWarning={versionHistoryWarning}
      versions={versions}
      versionWalkthroughStructure={versionWalkthroughStructure}
      wholeDiffLabel={wholeDiffLabel}
    />
  );
}
