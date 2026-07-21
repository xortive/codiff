import type { MarkdownAnnotationAnchor } from '@nkzw/mdx-editor';
import type { CodiffDiffStyle } from './config/types.ts';

export type DiffSection = {
  binary: boolean;
  id: string;
  kind: 'commit' | 'pull-request' | 'staged' | 'unstaged';
  loadState?: 'binary' | 'deferred' | 'directory' | 'error' | 'ready' | 'too-large';
  newFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  oldFile?: {
    cacheKey?: string;
    contents: string;
    name: string;
  };
  patch: string;
  summary?: {
    canLoad?: boolean;
    fileCount?: number;
    fingerprint?: string;
    limit?: number;
    reason: string;
    size?: number;
  };
};

export type GitFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';

export type ChangedFile = {
  fingerprint: string;
  generated?: boolean;
  oldPath?: string;
  path: string;
  sections: ReadonlyArray<DiffSection>;
  status: GitFileStatus;
};

export type ReviewAuthor = {
  avatarUrl?: string;
  login: string;
  name?: string;
  url?: string;
};

export type PullRequestReviewer = ReviewAuthor & {
  approved: boolean;
  id: string;
};

export type PullRequestReviewActionStatus = {
  disabled?: boolean;
  reason?: string;
};

export type PullRequestReviewStatus = {
  approve?: PullRequestReviewActionStatus;
  close?: PullRequestReviewActionStatus;
  comment?: PullRequestReviewActionStatus;
  requestChanges?: PullRequestReviewActionStatus;
};

export type PullRequestMergeCheckStatus = 'failed' | 'neutral' | 'pending' | 'success';

export type PullRequestMergeCheck = {
  detail?: string;
  label: string;
  status: PullRequestMergeCheckStatus;
  url?: string;
};

export type PullRequestMergeOptions = {
  removeSourceBranch: boolean;
  squash: boolean;
};

export type PullRequestCodeQualityFinding = {
  description: string;
  engineName?: string;
  filePath: string;
  fingerprint: string;
  lineNumber: number;
  severity: 'blocker' | 'critical' | 'info' | 'major' | 'minor' | 'unknown';
  status: 'existing' | 'new' | 'resolved';
  url?: string;
};

export type PullRequestMergeState = {
  autoMergeEnabled: boolean;
  canCancelAutoMerge: boolean;
  canMerge: boolean;
  canSetAutoMerge: boolean;
  checks: ReadonlyArray<PullRequestMergeCheck>;
  detailedStatus?: string;
  forceRemoveSourceBranch: boolean;
  mergeError?: string;
  options: PullRequestMergeOptions;
  reason?: string;
  sha: string;
  status: 'blocked' | 'checking' | 'closed' | 'merged' | 'ready' | 'waiting';
  statusLabel: string;
};

export type ReviewSource =
  | {
      type: 'working-tree';
    }
  | {
      ref: string;
      type: 'commit';
    }
  | {
      ref: string;
      type: 'branch';
    }
  | {
      /** Resolved base commit for a branch diff snapshot. */
      baseRef: string;
      /** Resolved head commit for a branch diff snapshot. */
      headRef: string;
      /** Target branch the current branch was compared against. */
      ref: string;
      type: 'branch-diff';
    }
  | {
      baseRef?: string;
      headRef?: string;
      ref: string;
      type: 'branch-working-tree';
    }
  | {
      /** Base ref (left side). For symmetric ranges the diff starts at its merge-base with head. */
      base: string;
      /** Head ref (right side). */
      head: string;
      /** `true` for `base...head` (merge-base), `false` for `base..head` (direct). */
      symmetric: boolean;
      type: 'range';
    }
  | {
      author?: ReviewAuthor;
      canEditDescription?: boolean;
      canEditReviewers?: boolean;
      canEditTitle?: boolean;
      description?: string;
      headSha?: string;
      host?: string;
      mergeState?: PullRequestMergeState;
      number?: number;
      owner?: string;
      projectPath?: string;
      provider?: 'github' | 'gitlab';
      repo?: string;
      reviewers?: ReadonlyArray<PullRequestReviewer>;
      reviewStatus?: PullRequestReviewStatus;
      title?: string;
      type: 'pull-request';
      url: string;
    };

export type HistoryEntry = {
  author: string;
  committedAt: number;
  gravatarUrl?: string;
  parents: ReadonlyArray<string>;
  ref: string;
  scope?: 'base' | 'pull-request';
  subject: string;
};

export type CommitMetadataPerson = {
  date: string;
  email: string;
  gravatarUrl?: string;
  name: string;
};

export type CommitMetadataFile = {
  additions?: number;
  binary: boolean;
  deletions?: number;
  oldPath?: string;
  path: string;
  status: GitFileStatus;
};

export type CommitMetadata = {
  author: CommitMetadataPerson;
  body: string;
  committer: CommitMetadataPerson;
  files: ReadonlyArray<CommitMetadataFile>;
  parents: ReadonlyArray<string>;
  ref: string;
  refs: ReadonlyArray<string>;
  shortRef: string;
  signature: {
    key?: string;
    signer?: string;
    status: string;
  };
  stats: {
    additions: number;
    binaryFiles: number;
    deletions: number;
    files: number;
    renamedFiles: number;
  };
  subject: string;
  trailers: ReadonlyArray<{
    key: string;
    value: string;
  }>;
};

export type RepositoryHistory = {
  entries: ReadonlyArray<HistoryEntry>;
  root: string;
};

export type RepositoryState = {
  branch: string | null;
  codeQualityFindings?: ReadonlyArray<PullRequestCodeQualityFinding>;
  commitMetadata?: CommitMetadata;
  files: ReadonlyArray<ChangedFile>;
  generalComments?: ReadonlyArray<PullRequestGeneralCommentThread>;
  generatedAt: number;
  launchPath: string;
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  root: string;
  source: ReviewSource;
};

export type CodiffFeatureFlags = {
  planSharing: boolean;
  walkthroughSharing: boolean;
};

export type WalkthroughProgressPhase = 'agent-generation' | 'response-received';

export type WalkthroughProgressEvent = {
  phase: WalkthroughProgressPhase;
};

export type CodiffMarkdownDocument = {
  content: string;
  id: string;
  kind: 'plan' | 'repository';
  path: string;
  version: string;
};

export type SaveMarkdownDocumentRequest = {
  baseVersion: string;
  content: string;
  kind: CodiffMarkdownDocument['kind'];
  path: string;
};

export type SaveMarkdownDocumentResult =
  | {
      document: CodiffMarkdownDocument;
      status: 'conflict';
    }
  | {
      document: CodiffMarkdownDocument;
      status: 'saved';
    };

export type PlanCommentAuthor = {
  avatarUrl?: string;
  email?: string;
  id: string;
  name: string;
  username?: string;
};

export type PlanCommentMessage = {
  author: PlanCommentAuthor;
  body: string;
  canDelete?: boolean;
  canEdit?: boolean;
  createdAt: string;
  id: string;
  updatedAt: string;
};

export type PlanCommentThread = {
  anchor: MarkdownAnnotationAnchor;
  canReply?: boolean;
  canResolve?: boolean;
  createdAt: string;
  createdBy: PlanCommentAuthor;
  id: string;
  messages: ReadonlyArray<PlanCommentMessage>;
  resolution?: {
    reason: 'agent-handled' | 'anchor-removed';
    resolvedAt: string;
  };
  status: 'open' | 'resolved';
  updatedAt: string;
};

export type PlanReview = {
  document: {
    id: string;
    path: string;
    version: string;
  };
  threads: ReadonlyArray<PlanCommentThread>;
  version: 1;
};

export type PlanHandoffStatus = 'closed' | 'done';

export type SharedWalkthroughSnapshot = {
  branch: string | null;
  codeQualityFindings?: ReadonlyArray<PullRequestCodeQualityFinding>;
  codiffVersion: string;
  exportedAt: string;
  files: ReadonlyArray<ChangedFile>;
  kind: 'codiff-walkthrough-share';
  preferences: Pick<
    CodiffPreferences,
    'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
  >;
  repository: {
    generalComments?: ReadonlyArray<PullRequestGeneralCommentThread>;
    root: string;
    source: ReviewSource;
    title?: string;
  };
  reviewComments?: ReadonlyArray<PullRequestExistingReviewComment>;
  version: 1;
  walkthrough: NarrativeWalkthrough;
};

export type SharedPlanSnapshot = {
  codiffVersion: string;
  document: {
    content: string;
    name: string;
    title: string;
  };
  exportedAt: string;
  kind: 'codiff-plan-share';
  preferences: Pick<CodiffPreferences, 'theme'>;
  review: {
    threads: ReadonlyArray<PlanCommentThread>;
    version: 1;
  };
  source?: {
    agent?: 'claude' | 'codex' | 'opencode' | 'pi';
    sessionId?: string;
  };
  version: 1;
};

export type ShareResult =
  | {
      status: 'uploaded';
      url: string;
    }
  | {
      reason: string;
      status: 'failed';
    };

export type SharePlanResult = ShareResult;

export type WalkthroughShareManifestV1 = SharedWalkthroughSnapshot;

export type ReviewPreferences = Pick<
  CodiffPreferences,
  'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
>;
export type ShareWalkthroughResult = ShareResult;

/**
 * Mutable display label for a revision.
 *
 * Labels can move or be renumbered (bookmarks, version tags). They are for
 * display and navigation only and must not be treated as durable identity.
 */
export type RevisionLabel = {
  kind: 'bookmark' | 'branch' | 'commit' | 'review-marker' | 'tag' | 'version';
  text: string;
  /** Optional provider web URL for this label (for example a commit page). */
  url?: string;
};

/**
 * Provider-neutral revision identity for this iteration of Codiff.
 *
 * `commitId` is the full Git commit SHA. Provider-specific extras such as a
 * GitLab `startSha` stay inside the provider adapter and are projected into
 * this shape at the host boundary.
 */
export type RevisionRef = {
  /** Additional display labels that resolve to the same commit. */
  aliases?: ReadonlyArray<RevisionLabel>;
  /** Full Git commit SHA for this iteration. */
  commitId: string;
  label: RevisionLabel;
};

/**
 * Provider-neutral base/head review range.
 *
 * Contains only review semantics shared across hosts. GitLab retains its full
 * `{ baseSha, startSha, headSha }` identity inside the GitLab adapter for
 * historical fetches, cache keys, and comment positions. `startSha` is not
 * authoring input.
 */
export type DiffRange = {
  base: RevisionRef;
  head: RevisionRef;
};

/** Identity of a before/after review comparison. */
export type DiffComparison = {
  after: DiffRange;
  before: DiffRange;
};

export type DiffComparisonCommentAssociation = {
  commentId: string;
  filePath?: string;
  status: 'newly-anchored' | 'outdated' | 'resolved-by-change' | 'still-valid';
};

export type DiffComparisonBaseMovementCommit = {
  authoredAt: string;
  authorName: string;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export type DiffComparisonBaseMovement = {
  changed: boolean;
  commits?: ReadonlyArray<DiffComparisonBaseMovementCommit>;
  commitsBetween: number | null;
  commitTimestampDeltaMs: number | null;
  diffStat: { additions: number; deletions: number; filesChanged: number } | null;
  from: { committedAt: string | null; sha: string; shortSha: string; webUrl?: string };
  relationship: 'forward' | 'backward' | 'divergent' | 'unknown';
  to: { committedAt: string | null; sha: string; shortSha: string; webUrl?: string };
  truncated: boolean;
  warning?: string;
};

export type DiffComparisonSummary = {
  addedLines: number;
  baseMoved: boolean;
  commentsAffected: number;
  conflictFiles: number;
  deletedLines: number;
  empty: boolean;
  filesChanged: number;
  intentionalFiles: number;
  noiseFiles: number;
};

export type ReviewCommitSummary = {
  authoredAt: string;
  authorName: string;
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  parentIds: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export type ReviewRebaseDriverCommit = {
  authoredAt: string;
  authorName: string;
  overlappingPaths: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

/**
 * Discriminated reviewable work unit.
 *
 * Units are generation targets only. Non-reviewable stack markers such as
 * retained or absorbed commits live on {@link ReviewEvolutionUnit}.
 */
export type ReviewUnit =
  | {
      commit: ReviewCommitSummary;
      id: string;
      /** Parent-to-commit range for an ordinary MR commit. */
      kind: 'commit';
      order: number;
      reviewable: true;
    }
  | {
      after: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      id: string;
      /** Newly added range between comparison endpoints. */
      kind: 'introduced';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      reviewable: true;
    }
  | {
      before: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      id: string;
      /** Reverse materialization of an earlier range removed from the stack. */
      kind: 'removed';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      reviewable: true;
    }
  | {
      after: ReviewCommitSummary;
      before: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      id: string;
      /** Comparison of earlier and later commit ranges for one logical change. */
      kind: 'revised';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      rebaseDrivers?: ReadonlyArray<ReviewRebaseDriverCommit>;
      reviewable: true;
    }
  | {
      after?: ReviewCommitSummary;
      before?: ReviewCommitSummary;
      confidence: 'exact' | 'high' | 'unmatched';
      id: string;
      /** Authoritative fallback range when pairing is uncertain. */
      kind: 'ambiguous';
      matchReasons?: ReadonlyArray<string>;
      matchScore?: number;
      order: number;
      reviewable: true;
    };

/** Non-reviewable evolution markers retained for stack display. */
export type ReviewEvolutionMarkerUnit = {
  after?: ReviewCommitSummary;
  baseCommit?: ReviewCommitSummary;
  before?: ReviewCommitSummary;
  confidence: 'exact' | 'high' | 'unmatched';
  id: string;
  kind: 'retained' | 'rewritten-same-patch' | 'absorbed-into-base';
  matchReasons?: ReadonlyArray<string>;
  matchScore?: number;
  order: number;
  reviewable: false;
};

export type ReviewEvolutionUnit = ReviewUnit | ReviewEvolutionMarkerUnit;

export type ReviewEvolutionSummary = {
  absorbedIntoBase: number;
  added: number;
  ambiguous: number;
  pairingCoverage: number;
  removed: number;
  retained: number;
  reviewable: number;
  revised: number;
  rewrittenSamePatch: number;
};

/**
 * Provider recommendation only. Hosts may override before resolving a
 * {@link ReviewPlan}.
 */
export type ReviewStructureRecommendation = {
  confidence?: number;
  rationale: string;
  suggestedStructure: 'commit-by-commit' | 'whole-diff';
};

export type ReviewCommitEvolution = {
  recommendation: ReviewStructureRecommendation;
  summary: ReviewEvolutionSummary;
  units: ReadonlyArray<ReviewEvolutionUnit>;
  warnings?: ReadonlyArray<string>;
};

/**
 * Derived comparison data kept separate from {@link DiffComparison} identity.
 */
export type DiffComparisonAnalysis = {
  baseMovement?: DiffComparisonBaseMovement;
  commentAssociations?: ReadonlyArray<DiffComparisonCommentAssociation>;
  commitEvolution?: ReviewCommitEvolution;
  summary: DiffComparisonSummary;
  warnings?: ReadonlyArray<string>;
};

/**
 * Resolved generation plan. Distinct from {@link ReviewStructureRecommendation}.
 *
 * - `whole-diff` materializes one {@link RepositoryState}
 * - `units` materializes one {@link RepositoryState} per {@link ReviewUnit}
 */
export type ReviewPlan =
  | {
      analysis?: DiffComparisonAnalysis;
      comparison?: DiffComparison;
      structure: 'whole-diff';
    }
  | {
      analysis?: DiffComparisonAnalysis;
      comparison?: DiffComparison;
      structure: 'units';
      units: ReadonlyArray<ReviewUnit>;
    };

/**
 * Host-facing version row for review history pickers.
 *
 * Durable identity is `id` plus the projected {@link DiffRange}. Provider
 * internals such as GitLab `startSha` remain in the adapter.
 */
export type ReviewVersionOption = {
  createdAt: string;
  diffStat?: { additions: number; deletions: number; filesChanged: number };
  id: string;
  isHead?: boolean;
  number?: number;
  previousCreatedAt?: string;
  previousNumber?: number;
  range: DiffRange;
};

/** Materialized comparison view consumed by shared review UI. */
export type DiffComparisonView = {
  analysis: DiffComparisonAnalysis;
  comparison: DiffComparison;
  files: ReadonlyArray<ChangedFile>;
  from: ReviewVersionOption;
  to: ReviewVersionOption;
};

export type ReviewCommitListEntry = {
  authoredAt: string;
  authorName: string;
  role?: string;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export type ReviewStrategySummary = {
  confidence: number;
  mode: 'commit-by-commit' | 'whole-diff';
  reason: string;
};

/**
 * Top-level walkthrough authoring context.
 *
 * A range target can use a whole-diff or ordinary commit-unit plan. A
 * comparison target requires comparison analysis and can use a whole-diff or
 * evolution-unit plan.
 */
export type WalkthroughGenerationInput =
  | {
      kind: 'range';
      plan: ReviewPlan;
      range: DiffRange;
      /** Present for whole-diff plans and as the aggregate state for composition. */
      state: RepositoryState;
      /** Present for unit plans: one materialized state per review unit. */
      unitStates?: ReadonlyArray<{ state: RepositoryState; unit: ReviewUnit }>;
    }
  | {
      analysis: DiffComparisonAnalysis;
      comparison: DiffComparison;
      kind: 'comparison';
      plan: ReviewPlan;
      /** Present for whole-diff comparison plans. */
      state?: RepositoryState;
      unitStates?: ReadonlyArray<{ state: RepositoryState; unit: ReviewUnit }>;
    };

export type WalkthroughContext = {
  changedFiles?: ReadonlyArray<{
    path: string;
    rationale?: string;
    role: string;
  }>;
  constraints?: ReadonlyArray<string>;
  decisions?: ReadonlyArray<string>;
  implementationSummary?: string;
  messages?: ReadonlyArray<{
    role: 'assistant' | 'user';
    text: string;
  }>;
  objective?: string;
  risks?: ReadonlyArray<string>;
  source: {
    generatedAt: string;
    threadId?: string;
    type:
      | 'codex-session'
      | 'codex-session-excerpt'
      | 'claude-session'
      | 'claude-session-excerpt'
      | 'opencode-session'
      | 'opencode-session-excerpt'
      | 'pi-session'
      | 'pi-session-excerpt';
  };
  validation?: ReadonlyArray<string>;
  version: 1;
};

export type CodiffLaunchOptions = {
  agentBackend?: 'codex' | 'claude' | 'opencode' | 'pi';
  claudeSessionId?: string;
  codexSessionId?: string;
  opencodeSessionId?: string;
  piSessionId?: string;
  /** Exact Markdown file opened by the blocking plan handoff. */
  planFile?: string;
  /** Result file used to resume the waiting agent process. */
  planResultFile?: string;
  repositoryPathProvided: boolean;
  source?: ReviewSource;
  walkthrough: boolean;
  walkthroughContext?: WalkthroughContext;
  /** Path to a pre-authored {@link NarrativeWalkthrough} JSON file (--walkthrough-file). */
  walkthroughFile?: string;
};

export type AgentSkillStatus = {
  installed: boolean;
  path: string;
};

/** @deprecated Use {@link AgentSkillStatus}. */
export type CodexSkillStatus = AgentSkillStatus;

export type TerminalHelperStatus = {
  command: string;
  installed: boolean;
  path: string;
};

/**
 * Narrative Walkthrough. The agent authors chapters, stops, and support groups
 * around deterministic hunk ids. Codiff resolves those ids against the live diff
 * and computes file paths, anchors, and line counts.
 */
export type WalkthroughIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'beaker' | 'doc' | 'gear';

/** Where a walkthrough hunk points into the live diff. */
export type WalkthroughAnchor = {
  /** Human-readable location, e.g. 'src/App.tsx:311' or 'src/hooks/useHunkOrder.ts (new)'. */
  display: string;
  /** End line on the {@link side} (inclusive). */
  endLine?: number;
  /** Matches {@link DiffSection.id}, e.g. 'src/App.tsx:staged'. */
  sectionId?: string;
  sectionKind?: DiffSection['kind'];
  side?: 'additions' | 'deletions' | 'both';
  /** Start line on the {@link side}. */
  startLine?: number;
};

/** A short header note rendered above one focused walkthrough hunk diff. */
export type WalkthroughHunkNote = {
  body: string;
  hunkId: string;
};

/**
 * Change-type tag shown on a file row in the commit composer. Mirrors the
 * walkthrough's narrative roles so a reviewer recognises each file at a glance.
 */
export type WalkthroughChangeType =
  | 'fix'
  | 'feature'
  | 'refactor'
  | 'test'
  | 'generated'
  | 'lockfile'
  | 'snapshot'
  | 'i18n'
  | 'docs';

/** One resolved hunk selected by a walkthrough item, in agent-requested order. */
export type WalkthroughHunk = {
  added: number;
  additionEnd?: number;
  additionStart?: number;
  anchor: WalkthroughAnchor;
  deleted: number;
  deletionEnd?: number;
  deletionStart?: number;
  id: string;
  /** `synthetic` hunks represent binary, deferred, or metadata-only review units. */
  kind?: 'patch' | 'synthetic';
  oldPath?: string;
  path: string;
  status: GitFileStatus;
};

/** Shared hunk-backed fields for a stop or support group. */
export type WalkthroughHunkGroup = {
  added: number;
  /** Change-type tag for the commit composer's file row. */
  changeType?: WalkthroughChangeType;
  /** One-line note the generated commit body uses for this file (falls back to {@link summary}). */
  commitNote?: string;
  deleted: number;
  /** Deterministic hunk ids selected by the authoring agent, in display order. */
  hunkIds: ReadonlyArray<string>;
  /** Resolved hunks with Codiff-computed anchors, file paths, status, and line counts. */
  hunks: ReadonlyArray<WalkthroughHunk>;
  /** Stable within the document, e.g. 's1'. */
  id: string;
  /** Optional header notes for individual hunk ids in this item. */
  notes?: ReadonlyArray<WalkthroughHunkNote>;
  /** Short, plain-text gist of the slice. */
  summary?: string;
  title?: string;
};

/** One stop in the main walkthrough path. */
export type WalkthroughCommentReference = {
  authorName: string;
  body: string;
  filePath: string;
  id: string;
  lineNumber?: number;
  status: 'newly-anchored' | 'outdated' | 'resolved-by-change' | 'still-valid';
  url?: string;
};

export type WalkthroughStop = WalkthroughHunkGroup & {
  /** Review comments whose anchored code region overlaps this stop. */
  commentReferences?: ReadonlyArray<WalkthroughCommentReference>;
  importance: 'critical' | 'normal' | 'context';
  /** Agent narration (markdown / inline code). */
  prose: string;
};

/** A changed hunk group kept off the main path. */
export type WalkthroughSupportGroup = WalkthroughHunkGroup & {
  note?: string;
  /** Why it is off the path, e.g. 'Generated' | 'Lockfile' | 'Snapshot' | 'Mechanical'. */
  reason: string;
};

/** A named chapter in the walkthrough. */
export type WalkthroughChapter = {
  blurb: string;
  /** Commit boundary metadata for commit-by-commit walkthroughs. */
  commit?: {
    gitSha?: string;
    /**
     * Base-branch commits that likely forced this MR commit rewrite on rebase.
     * Present for version-comparison commit-by-commit units when attribution exists.
     */
    rebaseDrivers?: ReadonlyArray<{
      authoredAt?: string;
      authorName?: string;
      overlappingPaths?: ReadonlyArray<string>;
      sha?: string;
      shortSha: string;
      subject: string;
      webUrl?: string;
    }>;
    revisionCause?: string;
    sha: string;
    shortSha: string;
    subject: string;
    webUrl?: string;
  };
  icon: WalkthroughIcon;
  id: string;
  stops: ReadonlyArray<WalkthroughStop>;
  title: string;
};

/**
 * Marks the walkthrough's diff as a staging set that can be committed and seeds
 * the commit composer Codiff renders as the walkthrough's terminal stop. Only
 * honored when {@link NarrativeWalkthrough.source} is a working tree — you can
 * only commit a live staging set, never a past commit, branch, or pull request.
 */
export type WalkthroughCommit = {
  /**
   * The agent-drafted commit body — a few paragraphs of prose describing the
   * change as a whole. Shown editable by default; the reviewer can rewrite it,
   * or ask the agent to regenerate it for a narrowed file selection.
   */
  body?: string;
  /** Suggested first line for the commit message. */
  title?: string;
};

export type NarrativeWalkthrough = {
  agent: 'codex' | 'claude' | 'opencode' | 'pi';
  chapters: ReadonlyArray<WalkthroughChapter>;
  /**
   * When present, the diff is a committable staging set: Codiff adds a commit
   * composer at the end of the walkthrough. Stripped unless `source` is a working tree.
   */
  commit?: WalkthroughCommit;
  /** Commit-scoped diff files used to resolve per-commit walkthrough hunk anchors. */
  commitFiles?: ReadonlyArray<ChangedFile>;
  /** The originating conversation, embedded for in-app Q&A. */
  context?: WalkthroughContext;
  /** 1–2 sentence summary of the change. */
  focus: string;
  /** ISO timestamp. */
  generatedAt: string;
  kind: 'narrative';
  /** Display string, e.g. '6 stops · 4 chapters'. */
  meta?: string;
  repo: {
    branch: string | null;
    root: string;
  };
  source: ReviewSource;
  support: ReadonlyArray<WalkthroughSupportGroup>;
  title: string;
  version: 4;
};

export type NarrativeWalkthroughResult =
  | {
      status: 'ready';
      walkthrough: NarrativeWalkthrough;
    }
  | {
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND' | 'OPENCODE_NOT_FOUND' | 'PI_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };

export type NarrativeWalkthroughRequestOptions = {
  /** Ignore an exact cache hit and replace it with a newly generated result. */
  force?: boolean;
  /**
   * The walkthrough currently shown. Regeneration uses its prose as continuity
   * while re-anchoring every stop against the current diff.
   */
  previousWalkthrough?: NarrativeWalkthrough;
};

/** Commit the selected files from a walkthrough's staging set. */
export type WalkthroughCommitRequest = {
  /** Body of the commit message (everything after the subject line). */
  body: string;
  /** Repo-relative paths to commit; other staged changes are left untouched. */
  paths: ReadonlyArray<string>;
  source?: ReviewSource;
  /** First line of the commit message. */
  subject: string;
};

export type WalkthroughCommitResult =
  | {
      /** Full SHA of the new commit. */
      hash: string;
      status: 'committed';
    }
  | {
      reason: string;
      status: 'failed';
    };

/**
 * Ask the connected agent to rewrite the commit message for the current file
 * selection — used when the reviewer drops files from the staging set and the
 * pre-drafted body no longer matches what is being committed.
 */
export type WalkthroughCommitMessageRequest = {
  /** The current body, given to the agent as the message to revise. */
  body: string;
  /** Repo-relative paths still selected for the commit. */
  paths: ReadonlyArray<string>;
  source?: ReviewSource;
  /** The current subject line. */
  subject: string;
};

export type WalkthroughCommitMessageResult =
  | {
      body: string;
      status: 'ready';
      subject: string;
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type ReviewAssistantRequest = {
  comment: {
    anchor?: 'file' | 'line';
    body: string;
    filePath: string;
    lineNumber?: number;
    sectionId: string;
    side?: 'additions' | 'deletions';
    startLineNumber?: number;
    startSide?: 'additions' | 'deletions';
  };
  source?: ReviewSource;
  walkthroughNote?: {
    action: 'review' | 'scan' | 'skim';
    context: string;
    groupReason: string;
    groupTitle: string;
    impact: 'wide' | 'contained' | 'mechanical';
    reason: string;
  };
};

export type ReviewAssistantResult =
  | {
      reply: string;
      status: 'ready';
    }
  | {
      code?: 'CODEX_NOT_FOUND' | 'CLAUDE_NOT_FOUND' | 'OPENCODE_NOT_FOUND' | 'PI_NOT_FOUND';
      reason: string;
      status: 'unavailable';
    };

export type GitIdentity = {
  email: string;
  gravatarUrl?: string;
  name: string;
  username?: string;
};

export type DiffSectionContentRequest = {
  force?: boolean;
  kind: DiffSection['kind'];
  path: string;
  showWhitespace?: boolean;
  source?: ReviewSource;
};

export type DiffImageContentRequest = {
  kind: DiffSection['kind'];
  path: string;
  source?: ReviewSource;
};

export type DiffImageRevision = {
  dataUrl: string;
  mimeType: string;
  name: string;
  size: number;
};

export type DiffImageContentResult =
  | {
      newImage?: DiffImageRevision;
      oldImage?: DiffImageRevision;
      status: 'ready';
    }
  | {
      reason: string;
      status: 'unavailable';
    };

export type CodiffTheme = 'system' | 'light' | 'dark';

export type CodiffPreferences = {
  agentBackend: 'codex' | 'claude' | 'opencode' | 'pi';
  claudeModel: string;
  codeFontFamily: string;
  codeFontSize: number;
  copyCommentsOnClose: boolean;
  diffStyle: CodiffDiffStyle;
  editorCommand: string;
  lastRepositoryPath: string;
  openAIModel: string;
  opencodeModel: string;
  piModel: string;
  reviewCommentsPrefix: string;
  showOutdated: boolean;
  showWhitespace: boolean;
  theme: CodiffTheme;
  walkthroughPrompt: string;
  wordWrap: boolean;
};

export type PullRequestReviewComment = {
  anchor?: 'file' | 'line';
  body: string;
  filePath: string;
  lineNumber?: number;
  sectionId?: string;
  side?: 'additions' | 'deletions';
  startLineNumber?: number;
  startSide?: 'additions' | 'deletions';
  threadId?: string;
};

export type PullRequestExistingReviewComment = PullRequestReviewComment & {
  author: ReviewAuthor;
  canDelete?: boolean;
  canEdit?: boolean;
  canReplyThread?: boolean;
  canResolveThread?: boolean;
  id: string;
  isOutdated?: boolean;
  isThreadResolved?: boolean;
  /** Diff identity the comment was positioned against (provider SHAs). */
  positionIdentity?: {
    baseSha: string;
    headSha: string;
    startSha: string;
  };
  resolution?: {
    confidence: 'approximate' | 'exact';
    nearbyHunkContext?: {
      after?: string;
      before?: string;
    };
    versions: ReadonlyArray<{
      fromLabel: string;
      toLabel: string;
    }>;
  };
  submittedAt?: string;
  url?: string;
  versionAssociation?: 'exact' | 'unmatched';
  versionHeadSha?: string;
  versionId?: string;
  versionLabel?: string;
};

export type PullRequestAIReviewDecision =
  | 'approved'
  | 'approved-with-comments'
  | 'changes-requested'
  | 'unknown';

export type PullRequestAIReview = {
  body: string;
  decision: PullRequestAIReviewDecision;
  id: string;
  reviewedHeadSha?: string;
  reviewer: ReviewAuthor & { id: string };
  submittedAt?: string;
  url?: string;
  versionAssociation?: 'exact' | 'unmatched';
  versionHeadSha?: string;
  versionId?: string;
  versionLabel?: string;
};

export type PullRequestGeneralComment = {
  author: ReviewAuthor;
  body: string;
  canDelete?: boolean;
  canEdit?: boolean;
  id: string;
  submittedAt?: string;
  url?: string;
};

export type PullRequestGeneralCommentThread = {
  canReply?: boolean;
  canResolve?: boolean;
  comments: ReadonlyArray<PullRequestGeneralComment>;
  id: string;
  isResolved?: boolean;
};

export type PullRequestReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type SubmitPullRequestCommentRequest = {
  comment: PullRequestReviewComment;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};

export type SubmitPullRequestReviewRequest = {
  body?: string;
  comments: ReadonlyArray<PullRequestReviewComment>;
  event: PullRequestReviewEvent;
  source: Extract<ReviewSource, { type: 'pull-request' }>;
};
