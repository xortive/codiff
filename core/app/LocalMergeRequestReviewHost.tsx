import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/ArrowsClockwise';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDefaultConfig } from '../config/defaults.ts';
import type { CodiffConfig } from '../config/types.ts';
import { sortFiles } from '../lib/files.ts';
import {
  classifyReviewCommit,
  classifyReviewStrategy,
  orderCommitsTopologically,
} from '../lib/review-strategy.ts';
import { getSourceLabel } from '../lib/source.ts';
import {
  MergeRequestReviewApp,
  type MergeRequestCommitListEntry,
  type MergeRequestReviewMode,
  type MergeRequestVersionCommitEvolution,
  type MergeRequestVersionCompareView,
  type MergeRequestVersionOption,
  type MergeRequestWalkthroughStatus,
} from '../SharedWalkthroughApp.tsx';
import type {
  ChangedFile,
  CodiffPreferences,
  GenerateLocalReviewWalkthroughRequest,
  GitIdentity,
  HistoryEntry,
  NarrativeWalkthrough,
  PullRequestExistingReviewComment,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  RepositoryState,
  WalkthroughGenerationProgress,
  ReviewEvolutionUnit,
  ReviewStrategySummary,
  ReviewSource,
} from '../types.ts';
import { Button } from './components/Button.tsx';

const getPreferencesFromConfig = ({ settings }: CodiffConfig): CodiffPreferences => ({
  ...settings,
});

const defaultPreferences = getPreferencesFromConfig(createDefaultConfig());

const toCommitListEntries = (
  entries: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<MergeRequestCommitListEntry> =>
  orderCommitsTopologically(
    entries
      .filter((entry) => entry.scope !== 'base')
      .map((entry) =>
        classifyReviewCommit({
          authoredDate: new Date(entry.committedAt).toISOString(),
          authorName: entry.author,
          message: entry.subject,
          parentIds: entry.parents,
          sha: entry.ref,
          shortSha: entry.ref.slice(0, 7),
          title: entry.subject,
        }),
      ),
  ).map((entry) => ({
    authoredAt: entry.authoredAt,
    authorName: entry.authorName,
    role: entry.role,
    sha: entry.sha,
    shortSha: entry.shortSha,
    subject: entry.subject,
    webUrl: entry.webUrl,
  }));

const shortUpdatedAge = (timestamp: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
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
  return `${Math.floor(hours / 24)}d ago`;
};

const getPullRequestTitle = (state: RepositoryState) => {
  if (state.source.type !== 'pull-request') {
    return 'Review';
  }
  return state.source.title?.trim() || getSourceLabel(state.source);
};

const getSourceIdentityKey = (source: ReviewSource) =>
  source.type === 'pull-request'
    ? `pull-request:${source.provider ?? ''}:${source.url}`
    : `${source.type}`;

const sortRepositoryState = (state: RepositoryState): RepositoryState => ({
  ...state,
  files: sortFiles(state.files),
});

const unsupportedGeneralComment = async (): Promise<void> => {
  throw new Error('General discussion comments are not supported in local Codiff yet.');
};

const unsupportedCommentUpdate = async (): Promise<void> => {
  throw new Error('Editing submitted review comments is not supported in local Codiff yet.');
};

export type LocalMergeRequestReviewHostProps = {
  gitIdentity?: GitIdentity | null;
  initialMode?: MergeRequestReviewMode;
  onHome: () => void;
  preferences?: Partial<
    Pick<
      CodiffPreferences,
      'codeFontFamily' | 'codeFontSize' | 'diffStyle' | 'showWhitespace' | 'theme' | 'wordWrap'
    >
  >;
  /** Preloaded snapshot handed off from App bootstrap. */
  state: RepositoryState;
};

type HostSessionProps = LocalMergeRequestReviewHostProps & {
  sourceKey: string;
};

/**
 * One session per PR/MR identity. App remounts this when the source key changes
 * so we avoid setState-in-effect reset patterns.
 */
function LocalMergeRequestReviewSession({
  gitIdentity = null,
  initialMode,
  onHome,
  preferences: preferencesProp,
  state: initialState,
}: HostSessionProps) {
  const [liveState, setLiveState] = useState<RepositoryState | null>(null);
  const state = liveState ?? sortRepositoryState(initialState);
  const stateRef = useRef(state);
  const [commits, setCommits] = useState<ReadonlyArray<MergeRequestCommitListEntry>>([]);
  const [reviewStrategy, setReviewStrategy] = useState<ReviewStrategySummary | null>(null);
  const [walkthrough, setWalkthrough] = useState<NarrativeWalkthrough | null>(null);
  const [walkthroughStatus, setWalkthroughStatus] = useState<MergeRequestWalkthroughStatus>('idle');
  const [walkthroughError, setWalkthroughError] = useState<string | null>(null);
  const [walkthroughProgress, setWalkthroughProgress] =
    useState<WalkthroughGenerationProgress | null>(null);
  const [configPreferences, setConfigPreferences] = useState(defaultPreferences);
  const [mode, setMode] = useState<MergeRequestReviewMode | undefined>(initialMode);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [versions, setVersions] = useState<ReadonlyArray<MergeRequestVersionOption>>([]);
  const [historyWarning, setHistoryWarning] = useState<string | null>(null);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(() => {
    if (initialState.source.type !== 'pull-request') {
      return false;
    }
    const provider = initialState.source.provider;
    return provider === 'gitlab' || provider === 'github' || provider == null;
  });
  const [versionCompare, setVersionCompare] = useState<MergeRequestVersionCompareView | null>(null);
  const [versionCompareLoading, setVersionCompareLoading] = useState(false);
  const [versionCompareError, setVersionCompareError] = useState<string | null>(null);
  const [versionCompareFromId, setVersionCompareFromId] = useState<string | null>(null);
  const [versionCompareToId, setVersionCompareToId] = useState<string | null>(null);
  const [versionCommitEvolution, setVersionCommitEvolution] =
    useState<MergeRequestVersionCommitEvolution | null>(null);
  const [versionCommitEvolutionLoading, setVersionCommitEvolutionLoading] = useState(false);
  const [versionCommitEvolutionError, setVersionCommitEvolutionError] = useState<string | null>(
    null,
  );
  const [versionWalkthroughStructure, setVersionWalkthroughStructure] = useState<
    'commit-by-commit' | 'whole-diff' | undefined
  >(undefined);
  const [lastRefreshAt, setLastRefreshAt] = useState(initialState.generatedAt);
  const [refreshNow, setRefreshNow] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const commitDiffCacheRef = useRef<Map<string, ReadonlyArray<ChangedFile>>>(new Map());
  const walkthroughRequestRef = useRef(0);
  const versionCompareRequestRef = useRef(0);
  const compareCacheRef = useRef<
    Map<
      string,
      {
        versionCommitEvolution: MergeRequestVersionCommitEvolution | null;
        versionCommitEvolutionError: string | null;
        versionCompare: MergeRequestVersionCompareView;
        warning?: string | null;
      }
    >
  >(new Map());

  useEffect(() => {
    const update = () => setRefreshNow(Date.now());
    const timeout = window.setTimeout(update, 0);
    const interval = window.setInterval(update, 60_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, []);

  const applyHistory = useCallback((history: { entries: ReadonlyArray<HistoryEntry> }) => {
    const nextCommits = toCommitListEntries(history.entries);
    setCommits(nextCommits);
    const source = stateRef.current.source;
    const strategy = classifyReviewStrategy({
      commits: history.entries
        .filter((entry) => entry.scope !== 'base')
        .map((entry) => ({
          authoredDate: new Date(entry.committedAt).toISOString(),
          authorName: entry.author,
          message: entry.subject,
          parentIds: entry.parents,
          sha: entry.ref,
          shortSha: entry.ref.slice(0, 7),
          title: entry.subject,
        })),
      description: source.type === 'pull-request' ? source.description : undefined,
      title: source.type === 'pull-request' ? source.title : undefined,
    });
    setReviewStrategy({
      confidence: strategy.confidence,
      mode: strategy.mode === 'whole-mr' ? 'whole-diff' : 'commit-by-commit',
      reason: strategy.reason,
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let canceled = false;
    window.codiff.getConfig().then(
      (config) => {
        if (!canceled) {
          setConfigPreferences(getPreferencesFromConfig(config));
        }
      },
      () => {},
    );
    const unsubscribe = window.codiff.onConfigChanged((config) => {
      setConfigPreferences(getPreferencesFromConfig(config));
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(
    () =>
      window.codiff.onWalkthroughProgress((event) => {
        if (event.generation) {
          setWalkthroughProgress(event.generation);
        }
      }),
    [],
  );

  useEffect(() => {
    if (state.source.type !== 'pull-request') {
      return;
    }

    let canceled = false;
    const source = state.source;

    const loadCommits = async () => {
      const history = await window.codiff.getRepositoryHistory(200, source);
      if (canceled) {
        return;
      }
      applyHistory(history);
    };

    loadCommits().catch(() => {
      if (!canceled) {
        setCommits([]);
      }
    });

    return () => {
      canceled = true;
    };
  }, [applyHistory, state.source]);

  useEffect(() => {
    if (state.source.type !== 'pull-request') {
      return;
    }
    const provider = state.source.provider;
    if (provider !== 'gitlab' && provider !== 'github' && provider != null) {
      return;
    }

    let canceled = false;
    const source = state.source;

    window.codiff
      .getReviewVersions({ source })
      .then((result) => {
        if (canceled) {
          return;
        }
        setVersions(result.versions);
        setHistoryWarning(result.warning ?? null);
        setVersionHistoryLoading(false);
      })
      .catch((error: unknown) => {
        if (canceled) {
          return;
        }
        setVersions([]);
        setHistoryWarning(error instanceof Error ? error.message : String(error));
        setVersionHistoryLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [state.source]);

  const refreshState = useCallback(async () => {
    const current = stateRef.current;
    if (current.source.type !== 'pull-request') {
      return;
    }
    const nextState = await window.codiff.getRepositoryState(current.source);
    const ordered = sortRepositoryState(nextState);
    stateRef.current = ordered;
    setLiveState(ordered);
    commitDiffCacheRef.current.clear();
    setSelectedCommitSha(null);
    setLastRefreshAt(ordered.generatedAt);
    setRefreshNow(Date.now());
  }, []);

  const refreshRemoteReview = useCallback(async () => {
    const current = stateRef.current;
    if (current.source.type !== 'pull-request' || refreshing) {
      return;
    }
    setRefreshing(true);
    setRefreshError(null);
    try {
      const [nextState, history, versionResult] = await Promise.all([
        window.codiff.getRepositoryState(current.source),
        window.codiff.getRepositoryHistory(200, current.source),
        window.codiff.getReviewVersions({ source: current.source }),
      ]);
      const ordered = sortRepositoryState(nextState);
      let comparison: Awaited<ReturnType<Window['codiff']['getReviewVersionCompare']>> | null =
        null;
      if (
        versionCompareFromId &&
        versionCompareToId &&
        versionResult.versions.some((version) => version.id === versionCompareFromId) &&
        versionResult.versions.some((version) => version.id === versionCompareToId)
      ) {
        comparison = await window.codiff.getReviewVersionCompare({
          fromId: versionCompareFromId,
          source: ordered.source as Extract<ReviewSource, { type: 'pull-request' }>,
          toId: versionCompareToId,
        });
      }

      stateRef.current = ordered;
      setLiveState(ordered);
      applyHistory(history);
      setVersions(versionResult.versions);
      setHistoryWarning(versionResult.warning ?? null);
      compareCacheRef.current.clear();
      commitDiffCacheRef.current.clear();
      setSelectedCommitSha(null);
      if (comparison) {
        setVersionCompare(comparison.versionCompare);
        setVersionCommitEvolution(comparison.versionCommitEvolution);
        setVersionCommitEvolutionError(comparison.versionCommitEvolutionError);
      } else if (versionCompareFromId || versionCompareToId) {
        versionCompareRequestRef.current += 1;
        setVersionCompare(null);
        setVersionCompareFromId(null);
        setVersionCompareToId(null);
        setVersionCompareError(null);
        setVersionCompareLoading(false);
        setVersionCommitEvolution(null);
        setVersionCommitEvolutionError(null);
        setVersionCommitEvolutionLoading(false);
        setVersionWalkthroughStructure(undefined);
      }
      setLastRefreshAt(ordered.generatedAt);
      setRefreshNow(Date.now());
    } catch (error: unknown) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }, [applyHistory, refreshing, versionCompareFromId, versionCompareToId]);

  useEffect(() => window.codiff.onRefreshRequest(() => void refreshState()), [refreshState]);

  const onSubmitComment = useCallback(
    async (comment: PullRequestReviewComment): Promise<PullRequestExistingReviewComment> => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        throw new Error('Review comments require a pull request source.');
      }
      const submitted = await window.codiff.submitPullRequestComment({
        comment,
        source: current.source,
      });
      await refreshState();
      return submitted;
    },
    [refreshState],
  );

  const onSubmitReview = useCallback(
    async (
      event: PullRequestReviewEvent,
      comments: ReadonlyArray<PullRequestReviewComment>,
      body?: string,
    ) => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        throw new Error('Reviews require a pull request source.');
      }
      await window.codiff.submitPullRequestReview({
        ...(body ? { body } : {}),
        comments,
        event,
        source: current.source,
      });
      await refreshState();
    },
    [refreshState],
  );

  const onSubmitGeneralComment = useCallback(async (_body: string) => {
    await unsupportedGeneralComment();
  }, []);

  const onUpdateComment = useCallback(async (_commentId: string, _body: string) => {
    await unsupportedCommentUpdate();
  }, []);

  const onUpdateGeneralComment = useCallback(async (_commentId: string, _body: string) => {
    await unsupportedCommentUpdate();
  }, []);

  const onLoadCommitDiff = useCallback(async (sha: string) => {
    const cached = commitDiffCacheRef.current.get(sha);
    if (cached) {
      setSelectedCommitSha(sha);
      return cached;
    }
    const commitState = await window.codiff.getRepositoryState({
      ref: sha,
      type: 'commit',
    } satisfies ReviewSource);
    const files = sortFiles(commitState.files);
    commitDiffCacheRef.current.set(sha, files);
    setSelectedCommitSha(sha);
    return files;
  }, []);

  const onLoadVersionCommitDiff = useCallback(
    async (unitId: string) => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        return [];
      }
      const unit = versionCommitEvolution?.units.find((candidate) => candidate.id === unitId);
      if (!unit) {
        throw new Error(`Unknown version commit unit: ${unitId}`);
      }
      return window.codiff.getReviewVersionUnitDiff({
        source: current.source,
        unit: unit as ReviewEvolutionUnit,
      });
    },
    [versionCommitEvolution],
  );

  const loadVersionCompare = useCallback(
    async (
      fromId: string,
      toId: string,
      endpoints?: {
        from?: Parameters<Window['codiff']['getReviewVersionCompare']>[0]['from'];
        to?: Parameters<Window['codiff']['getReviewVersionCompare']>[0]['to'];
      },
    ) => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        return;
      }
      if (!fromId || !toId || fromId === toId) {
        return;
      }

      const requestId = ++versionCompareRequestRef.current;
      setVersionCompareFromId(fromId);
      setVersionCompareToId(toId);
      setVersionCompareError(null);
      setVersionCommitEvolutionError(null);

      const cacheKey = `${current.source.url}:${fromId}:${toId}:${JSON.stringify(endpoints ?? null)}`;
      const cached = compareCacheRef.current.get(cacheKey);
      if (cached) {
        setVersionCompare(cached.versionCompare);
        setVersionCommitEvolution(cached.versionCommitEvolution);
        setVersionCommitEvolutionError(cached.versionCommitEvolutionError);
        setVersionCompareLoading(false);
        setVersionCommitEvolutionLoading(false);
        if (cached.versionCommitEvolution?.recommendation.suggestedStructure) {
          setVersionWalkthroughStructure(
            cached.versionCommitEvolution.recommendation.suggestedStructure,
          );
        }
        if (cached.warning) {
          setHistoryWarning(cached.warning);
        }
        setWalkthrough(null);
        setWalkthroughStatus('idle');
        setWalkthroughError(null);
        return;
      }

      setVersionCompareLoading(true);
      setVersionCommitEvolutionLoading(true);

      try {
        const result = await window.codiff.getReviewVersionCompare({
          ...(endpoints?.from ? { from: endpoints.from } : { fromId }),
          source: current.source,
          ...(endpoints?.to ? { to: endpoints.to } : { toId }),
        });
        if (requestId !== versionCompareRequestRef.current) {
          return;
        }
        compareCacheRef.current.set(cacheKey, result);
        setVersionCompareFromId(result.versionCompare.from.id);
        setVersionCompareToId(result.versionCompare.to.id);
        setVersionCompare(result.versionCompare);
        setVersionCommitEvolution(result.versionCommitEvolution);
        setVersionCommitEvolutionError(result.versionCommitEvolutionError);
        setVersionCompareLoading(false);
        setVersionCommitEvolutionLoading(false);
        if (result.warning) {
          setHistoryWarning(result.warning);
        }
        if (result.versionCommitEvolution?.recommendation.suggestedStructure) {
          setVersionWalkthroughStructure(
            result.versionCommitEvolution.recommendation.suggestedStructure,
          );
        }
        // Clear baseline walkthrough so compare mode can regenerate for the range.
        setWalkthrough(null);
        setWalkthroughStatus('idle');
        setWalkthroughError(null);
      } catch (error: unknown) {
        if (requestId !== versionCompareRequestRef.current) {
          return;
        }
        setVersionCompare(null);
        setVersionCommitEvolution(null);
        setVersionCompareError(error instanceof Error ? error.message : String(error));
        setVersionCompareLoading(false);
        setVersionCommitEvolutionLoading(false);
      }
    },
    [],
  );

  const onOpenVersionCompare = useCallback(
    (options?: { commentId?: string }) => {
      if (versions.length < 2) {
        return;
      }
      const comment = options?.commentId
        ? stateRef.current.reviewComments?.find((candidate) => candidate.id === options.commentId)
        : null;
      const currentVersion = versions.at(-1);
      const commentVersion = comment
        ? versions.find(
            (version) =>
              version.id === comment.versionId ||
              version.range.head.commitId ===
                (comment.positionIdentity?.headSha ?? comment.versionHeadSha),
          )
        : null;
      if (comment?.positionIdentity && currentVersion) {
        const fallbackFrom =
          commentVersion?.id === currentVersion.id
            ? (versions.at(-2)?.id ?? commentVersion.id)
            : (commentVersion?.id ?? comment.positionIdentity.headSha);
        if (fallbackFrom && fallbackFrom !== currentVersion.id) {
          void loadVersionCompare(fallbackFrom, currentVersion.id, {
            from: {
              ...comment.positionIdentity,
              commentId: comment.id,
              kind: 'comment-position',
            },
            to: { id: currentVersion.id, kind: 'version' },
          });
          return;
        }
      }
      if (commentVersion && currentVersion && commentVersion.id !== currentVersion.id) {
        void loadVersionCompare(commentVersion.id, currentVersion.id);
        return;
      }
      // Default: previous version → current head (newest last in our list).
      const toId = versions.at(-1)?.id;
      const fromId = versions.at(-2)?.id;
      if (!fromId || !toId) {
        return;
      }
      void loadVersionCompare(fromId, toId);
    },
    [loadVersionCompare, versions],
  );

  const onExitVersionCompare = useCallback(() => {
    versionCompareRequestRef.current += 1;
    setVersionCompare(null);
    setVersionCompareFromId(null);
    setVersionCompareToId(null);
    setVersionCompareError(null);
    setVersionCompareLoading(false);
    setVersionCommitEvolution(null);
    setVersionCommitEvolutionError(null);
    setVersionCommitEvolutionLoading(false);
    setVersionWalkthroughStructure(undefined);
    setWalkthrough(null);
    setWalkthroughStatus('idle');
    setWalkthroughError(null);
    setWalkthroughProgress(null);
  }, []);

  const onVersionCompareRangeChange = useCallback(
    (fromId: string, toId: string) => {
      void loadVersionCompare(fromId, toId);
    },
    [loadVersionCompare],
  );

  const onGenerateWalkthrough = useCallback(
    async (options?: {
      force?: boolean;
      reviewStructure?: 'commit-by-commit' | 'whole-diff';
      unitId?: string;
      versionCompare?: {
        fromId: string;
        toId: string;
        walkthroughStructure?: 'auto' | 'commit-by-commit' | 'whole-diff';
      };
    }) => {
      const current = stateRef.current;
      if (current.source.type !== 'pull-request') {
        return;
      }

      const requestId = ++walkthroughRequestRef.current;
      setWalkthroughError(null);
      try {
        const structure: NonNullable<GenerateLocalReviewWalkthroughRequest['structure']> =
          options?.unitId || options?.reviewStructure === 'commit-by-commit'
            ? 'units'
            : options?.reviewStructure === 'whole-diff'
              ? 'whole-diff'
              : options?.versionCompare?.walkthroughStructure === 'commit-by-commit'
                ? 'units'
                : options?.versionCompare?.walkthroughStructure === 'whole-diff'
                  ? 'whole-diff'
                  : reviewStrategy?.mode === 'commit-by-commit'
                    ? 'units'
                    : reviewStrategy?.mode === 'whole-diff'
                      ? 'whole-diff'
                      : 'auto';
        const versionCompareRequest = options?.versionCompare
          ? {
              fromId: options.versionCompare.fromId,
              toId: options.versionCompare.toId,
            }
          : versionCompareFromId && versionCompareToId
            ? {
                fromId: versionCompareFromId,
                toId: versionCompareToId,
              }
            : undefined;
        const request = {
          source: current.source,
          structure,
          ...(versionCompareRequest ? { versionCompare: versionCompareRequest } : {}),
        } satisfies Omit<GenerateLocalReviewWalkthroughRequest, 'force' | 'unitId'>;
        if (!options?.force && !options?.unitId) {
          const stored = await window.codiff.getStoredReviewWalkthrough(request);
          if (requestId !== walkthroughRequestRef.current) {
            return;
          }
          if (stored.status === 'ready') {
            setWalkthrough(stored.walkthrough);
            setWalkthroughStatus('ready');
            setWalkthroughProgress(null);
            return;
          }
        }

        setWalkthroughStatus('generating');
        setWalkthroughProgress({
          phase: 'preparing',
          summary: 'Starting generation.',
        });
        const result = await window.codiff.generateReviewWalkthrough({
          ...request,
          ...(options?.force ? { force: true } : {}),
          ...(options?.unitId ? { unitId: options.unitId } : {}),
        });
        if (requestId !== walkthroughRequestRef.current) {
          return;
        }
        if (result.status === 'ready') {
          setWalkthrough(result.walkthrough);
          setWalkthroughStatus('ready');
          setWalkthroughProgress(null);
          setWalkthroughError(null);
          return;
        }
        setWalkthrough(null);
        setWalkthroughStatus('failed');
        setWalkthroughProgress(null);
        setWalkthroughError(result.reason);
      } catch (error: unknown) {
        if (requestId !== walkthroughRequestRef.current) {
          return;
        }
        setWalkthrough(null);
        setWalkthroughStatus('failed');
        setWalkthroughProgress(null);
        setWalkthroughError(error instanceof Error ? error.message : String(error));
      }
    },
    [reviewStrategy, versionCompareFromId, versionCompareToId],
  );

  const title = useMemo(() => getPullRequestTitle(state), [state]);
  const externalUrl = state.source.type === 'pull-request' ? state.source.url : '';
  const supportsReviewHistory =
    state.source.type === 'pull-request' &&
    (state.source.provider === 'gitlab' ||
      state.source.provider === 'github' ||
      state.source.provider == null);
  const providerLabel =
    state.source.type === 'pull-request' && state.source.provider === 'gitlab'
      ? 'GitLab'
      : 'GitHub';
  const versionHistoryTitle =
    state.source.type === 'pull-request' && state.source.provider === 'gitlab'
      ? 'Versions'
      : 'Head history';
  const wholeDiffLabel =
    state.source.type === 'pull-request' && state.source.provider === 'gitlab'
      ? 'Whole MR'
      : 'Whole PR';

  const resolvedPreferences = useMemo(
    () => ({
      codeFontFamily: preferencesProp?.codeFontFamily ?? configPreferences.codeFontFamily,
      codeFontSize: preferencesProp?.codeFontSize ?? configPreferences.codeFontSize,
      diffStyle: preferencesProp?.diffStyle ?? configPreferences.diffStyle,
      showWhitespace: preferencesProp?.showWhitespace ?? configPreferences.showWhitespace,
      theme: preferencesProp?.theme ?? configPreferences.theme,
      wordWrap: preferencesProp?.wordWrap ?? configPreferences.wordWrap,
    }),
    [configPreferences, preferencesProp],
  );

  if (state.source.type !== 'pull-request') {
    return null;
  }

  return (
    <MergeRequestReviewApp
      commits={commits}
      externalUrl={externalUrl}
      gitIdentity={gitIdentity}
      initialMode={mode}
      onExitVersionCompare={supportsReviewHistory ? onExitVersionCompare : undefined}
      onGenerateWalkthrough={onGenerateWalkthrough}
      onHome={onHome}
      onLoadCommitDiff={onLoadCommitDiff}
      onLoadVersionCommitDiff={supportsReviewHistory ? onLoadVersionCommitDiff : undefined}
      onModeChange={setMode}
      onOpenVersionCompare={supportsReviewHistory ? onOpenVersionCompare : undefined}
      onSubmitComment={onSubmitComment}
      onSubmitGeneralComment={onSubmitGeneralComment}
      onSubmitReview={onSubmitReview}
      onUpdateComment={onUpdateComment}
      onUpdateGeneralComment={onUpdateGeneralComment}
      onVersionCompareRangeChange={supportsReviewHistory ? onVersionCompareRangeChange : undefined}
      onVersionWalkthroughStructureChange={setVersionWalkthroughStructure}
      preferences={resolvedPreferences}
      providerLabel={providerLabel}
      reviewStrategy={reviewStrategy}
      selectedCommitSha={selectedCommitSha}
      settingsBar={
        <Button
          aria-label={`Refresh ${state.source.provider === 'gitlab' ? 'MR' : 'PR'}`}
          disabled={refreshing}
          onClick={() => void refreshRemoteReview()}
          size="sm"
          title={
            refreshError
              ? `Refresh failed: ${refreshError}`
              : `Last refreshed ${new Date(lastRefreshAt).toLocaleString()}`
          }
          type="button"
          variant="ghost"
        >
          <ArrowsClockwise aria-hidden size={14} weight="bold" />
          {`Refresh ${state.source.provider === 'gitlab' ? 'MR' : 'PR'} · updated ${shortUpdatedAge(lastRefreshAt, refreshNow ?? lastRefreshAt)}`}
        </Button>
      }
      state={state}
      title={title}
      versionCommitEvolution={versionCommitEvolution}
      versionCommitEvolutionError={versionCommitEvolutionError}
      versionCommitEvolutionLoading={versionCommitEvolutionLoading}
      versionCompare={versionCompare}
      versionCompareEnabled={Boolean(
        versionCompareFromId || versionCompareToId || versionCompareLoading || versionCompare,
      )}
      versionCompareError={versionCompareError}
      versionCompareFromId={versionCompareFromId}
      versionCompareLoading={versionCompareLoading}
      versionCompareToId={versionCompareToId}
      versionHistoryLabel={versionHistoryTitle}
      versionHistoryLoading={versionHistoryLoading}
      versionHistoryWarning={historyWarning}
      versions={versions}
      versionWalkthroughStructure={versionWalkthroughStructure}
      walkthrough={walkthrough}
      walkthroughError={walkthroughError}
      walkthroughProgress={walkthroughProgress}
      walkthroughStatus={walkthroughStatus}
      wholeDiffLabel={wholeDiffLabel}
    />
  );
}

/**
 * Desktop host adapter for pull-request / merge-request sources.
 * Feeds Core `MergeRequestReviewApp` with local IPC-backed data and actions.
 * GitLab sources also load package-backed version history / compare / evolution.
 */
export function LocalMergeRequestReviewHost(props: LocalMergeRequestReviewHostProps) {
  const sourceKey = getSourceIdentityKey(props.state.source);
  return <LocalMergeRequestReviewSession key={sourceKey} {...props} sourceKey={sourceKey} />;
}

export function shouldUseLocalMergeRequestHost(source: ReviewSource | null | undefined): boolean {
  return source?.type === 'pull-request';
}
