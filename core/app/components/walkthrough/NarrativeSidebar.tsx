import { getAgentLabel } from '../../../lib/app-constants.ts';
import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import {
  buildCommitModel,
  formatWalkthroughFileLineRows,
  getUncoveredWalkthroughFileLineItems,
  isWalkthroughCommittable,
  walkthroughItemTitleFallback,
  type WalkthroughView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../../../types.ts';
import { CommitRefTooltip } from '../CommitRefTooltip.tsx';
import { ArrowsClockwise, Check, GitBranch, Path, ShareNetwork } from './icons.tsx';
import { ChapterIcon } from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

const agentLabel = (agentId: NarrativeWalkthrough['agent']) => getAgentLabel(agentId);

function TocFileRows({
  files,
}: {
  files: ReadonlyArray<{
    added: number;
    deleted: number;
    label: string;
    path?: string;
    title: string;
  }>;
}) {
  return (
    <span className="wt-toc-file-list">
      {files.map((file, index) => (
        <span className="wt-toc-file-row" key={file.path ?? `${file.title}:${file.label}:${index}`}>
          <span className="wt-toc-file" title={file.title}>
            {file.label}
          </span>
          <span className="wt-toc-count">
            <span className="added">+{file.added}</span>
            {file.deleted > 0 ? <span className="deleted">−{file.deleted}</span> : null}
          </span>
        </span>
      ))}
    </span>
  );
}

function TocStop({
  current,
  onSelect,
  stop,
  visited,
}: {
  current: boolean;
  onSelect: (index: number) => void;
  stop: WalkthroughStopView;
  visited: boolean;
}) {
  const isDone = visited && !current;
  const files = formatWalkthroughFileLineRows(stop.hunks);
  const title = stop.title ?? walkthroughItemTitleFallback(stop);
  return (
    <button
      className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' visited' : ''}`}
      onClick={() => onSelect(stop.index)}
      title={title}
      type="button"
    >
      <span className="wt-toc-rail">
        {isDone ? (
          <span className="wt-toc-node done">
            <Check size={8} weight="bold" />
          </span>
        ) : (
          <span className={`wt-toc-node${current ? ' current' : ''}`}>
            {current ? <span className="wt-toc-node-pulse" /> : null}
          </span>
        )}
      </span>
      <span className="wt-toc-main">
        <span className="wt-toc-title-row">
          <span className="wt-toc-num">{stop.index + 1}</span>
          <span className="wt-toc-title">{title}</span>
        </span>
        <TocFileRows files={files} />
      </span>
    </button>
  );
}

function SupportingFilesStop({
  changedPaths,
  files,
  navigation,
  showWhitespace,
  walkthroughView,
}: {
  changedPaths?: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  showWhitespace: boolean;
  walkthroughView: WalkthroughView;
}) {
  const uncoveredFiles = getUncoveredWalkthroughFileLineItems(
    files,
    walkthroughView,
    showWhitespace,
  ).filter((file) => !changedPaths?.has(file.path));
  if (walkthroughView.support.length === 0 && uncoveredFiles.length === 0) {
    return null;
  }
  const current = navigation.mode === 'support';
  const isDone = navigation.supportVisited && !current;
  const fileRows = formatWalkthroughFileLineRows([
    ...walkthroughView.support.flatMap((item) => item.hunks),
    ...uncoveredFiles,
  ]);
  return (
    <div className="wt-toc-chapter">
      <div className="wt-toc-chapter-head">
        <span className="wt-toc-chapter-icon">
          <Path size={15} />
        </span>
        <span className="wt-toc-chapter-title">Support</span>
      </div>
      <div className="wt-toc-stops">
        <button
          className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' visited' : ''}`}
          onClick={navigation.openSupport}
          title="Changed alongside the main walkthrough"
          type="button"
        >
          <span className="wt-toc-rail">
            {isDone ? (
              <span className="wt-toc-node done">
                <Check size={8} weight="bold" />
              </span>
            ) : (
              <span className={`wt-toc-node${current ? ' current' : ''}`}>
                {current ? <span className="wt-toc-node-pulse" /> : null}
              </span>
            )}
          </span>
          <span className="wt-toc-main">
            <TocFileRows files={fileRows} />
          </span>
        </button>
      </div>
    </div>
  );
}

function ChangedFilesStop({
  changedPaths,
  files,
  navigation,
  showWhitespace,
  walkthroughView,
}: {
  changedPaths?: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  showWhitespace: boolean;
  walkthroughView: WalkthroughView;
}) {
  const changedFiles = getUncoveredWalkthroughFileLineItems(
    files,
    walkthroughView,
    showWhitespace,
  ).filter((file) => changedPaths?.has(file.path));
  if (changedFiles.length === 0) {
    return null;
  }
  const fileRows = formatWalkthroughFileLineRows(changedFiles);
  return (
    <div className="wt-toc-chapter">
      <div className="wt-toc-chapter-head">
        <span className="wt-toc-chapter-icon">
          <ArrowsClockwise size={15} />
        </span>
        <span className="wt-toc-chapter-title">Changed</span>
      </div>
      <div className="wt-toc-stops">
        <button
          className="wt-toc-stop"
          onClick={navigation.openSupport}
          title="Changed after the walkthrough was generated"
          type="button"
        >
          <span className="wt-toc-rail">
            <span className="wt-toc-node" />
          </span>
          <span className="wt-toc-main">
            <TocFileRows files={fileRows} />
          </span>
        </button>
      </div>
    </div>
  );
}

const commitEvolutionKindClass = (kind: string | undefined) => {
  switch (kind) {
    case 'added':
    case 'introduced':
      return 'evolution-added';
    case 'removed':
      return 'evolution-removed';
    case 'likely-revised':
    case 'revised':
      return 'evolution-revised';
    case 'absorbed-into-base':
      return 'evolution-absorbed';
    case 'ambiguous':
      return 'evolution-ambiguous';
    default:
      return 'evolution-unchanged';
  }
};

const commitEvolutionSymbol = (kind: string | undefined) => {
  switch (kind) {
    case 'added':
    case 'introduced':
      return '+';
    case 'removed':
      return '−';
    case 'likely-revised':
    case 'revised':
      return '~';
    case 'absorbed-into-base':
      return '↳';
    case 'ambiguous':
      return '?';
    default:
      return '·';
  }
};

export function NarrativeSidebar({
  allowCommit = true,
  changedPaths,
  commitEvolutionKinds,
  files,
  navigation,
  onRegenerateWalkthrough,
  onShareWalkthrough,
  shareWalkthroughDisabled = false,
  showWhitespace,
  walkthrough,
}: {
  allowCommit?: boolean;
  changedPaths?: ReadonlySet<string>;
  commitEvolutionKinds?: ReadonlyMap<string, string>;
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  onRegenerateWalkthrough?: () => void;
  onShareWalkthrough?: () => void;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  walkthrough: NarrativeWalkthrough;
}) {
  const { walkthroughView } = navigation;
  if (!walkthroughView) {
    return <div className="wt-empty">This walkthrough has no readable sequence.</div>;
  }

  const currentStopId =
    navigation.mode === 'stop' ? walkthroughView.sequence[navigation.index]?.id : null;

  const committable = allowCommit && isWalkthroughCommittable(walkthrough);
  const commitModel = committable ? buildCommitModel(walkthroughView, files) : null;
  const commitFiles = commitModel
    ? formatWalkthroughFileLineRows(
        commitModel.files.filter((file) => navigation.commitSelected.has(file.path)),
      )
    : null;

  return (
    <div className="walkthrough-list">
      <div className="wt-focus">
        <div className="wt-focus-header">
          <span className="wt-focus-label">Review focus</span>
          {onRegenerateWalkthrough ? (
            <button
              aria-label="Regenerate walkthrough"
              className="wt-regen-button"
              onClick={onRegenerateWalkthrough}
              title="Regenerate full walkthrough"
              type="button"
            >
              Regen walkthrough
            </button>
          ) : null}
        </div>
        <p>{renderInlineMarkdown(walkthrough.focus)}</p>
      </div>

      <div className="wt-toc-scroll">
        {walkthroughView.chapters.map((chapter) => (
          <div
            className={`wt-toc-chapter${chapter.commit ? ' commit-boundary' : ''}`}
            key={chapter.id}
          >
            {chapter.commit ? (
              <div
                className={`wt-commit-boundary-label${commitEvolutionKinds ? ` ${commitEvolutionKindClass(commitEvolutionKinds.get(chapter.commit.sha))}` : ''}`}
                title={[
                  `${chapter.commit.shortSha} ${chapter.commit.subject}`,
                  ...(chapter.commit.rebaseDrivers ?? []).map(
                    (driver) => `${driver.shortSha} ${driver.subject}`,
                  ),
                  chapter.commit.revisionCause,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                {commitEvolutionKinds ? (
                  <span
                    className={`wt-commit-evolution-indicator ${commitEvolutionKindClass(commitEvolutionKinds.get(chapter.commit.sha))}`}
                  >
                    {commitEvolutionSymbol(commitEvolutionKinds.get(chapter.commit.sha))}
                  </span>
                ) : null}
                <CommitRefTooltip
                  commit={{
                    sha: chapter.commit.gitSha ?? chapter.commit.sha,
                    shortSha: chapter.commit.shortSha,
                    subject: chapter.commit.subject,
                    webUrl: chapter.commit.webUrl,
                  }}
                />
                <span className="wt-commit-boundary-subject">{chapter.commit.subject}</span>
                {(chapter.commit.rebaseDrivers?.length ?? 0) > 0 ? (
                  <span
                    aria-label={`Revised due to rebase: ${chapter.commit.rebaseDrivers
                      ?.map((driver) => `${driver.shortSha} ${driver.subject}`)
                      .join('; ')}`}
                    className="wt-commit-rebase-badge"
                    tabIndex={0}
                  >
                    Revised due to rebase
                  </span>
                ) : chapter.commit.revisionCause ? (
                  <span className="wt-commit-rebase-badge" title={chapter.commit.revisionCause}>
                    Revised due to rebase
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon">
                <ChapterIcon icon={chapter.icon} size={15} />
              </span>
              <span className="wt-toc-chapter-title">{chapter.title}</span>
            </div>
            <div className="wt-toc-stops">
              {chapter.stops.map((stop) => (
                <TocStop
                  current={navigation.mode === 'stop' && stop.id === currentStopId}
                  key={stop.id}
                  onSelect={navigation.goStop}
                  stop={stop}
                  visited={navigation.visited.has(stop.id)}
                />
              ))}
            </div>
          </div>
        ))}
        <SupportingFilesStop
          changedPaths={changedPaths}
          files={files}
          navigation={navigation}
          showWhitespace={showWhitespace}
          walkthroughView={walkthroughView}
        />
        <ChangedFilesStop
          changedPaths={changedPaths}
          files={files}
          navigation={navigation}
          showWhitespace={showWhitespace}
          walkthroughView={walkthroughView}
        />
        {committable && commitFiles ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <GitBranch size={15} />
              </span>
              <span className="wt-toc-chapter-title">Commit</span>
            </div>
            <div
              className={`wt-toc-stop wt-toc-stop-actions${
                navigation.mode === 'commit' ? ' current' : ''
              }`}
            >
              <span className="wt-toc-rail wt-toc-rail-commit">
                <span className={`wt-toc-node${navigation.mode === 'commit' ? ' current' : ''}`}>
                  {navigation.mode === 'commit' ? <span className="wt-toc-node-pulse" /> : null}
                </span>
              </span>
              <span className="wt-toc-main wt-toc-main-actions">
                <button
                  className="wt-toc-commit-action"
                  onClick={navigation.enterCommit}
                  type="button"
                >
                  <span className="wt-toc-title-row">
                    <span className="wt-toc-title">Write the commit</span>
                  </span>
                  <TocFileRows files={commitFiles} />
                </button>
              </span>
            </div>
          </div>
        ) : onShareWalkthrough ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <ShareNetwork size={15} />
              </span>
              <span className="wt-toc-chapter-title">Share</span>
            </div>
            <div className="wt-toc-stop wt-toc-stop-actions">
              <span className="wt-toc-rail wt-toc-rail-commit">
                <span className="wt-toc-node" />
              </span>
              <span className="wt-toc-main wt-toc-main-actions">
                <button
                  className="wt-toc-commit-action"
                  disabled={shareWalkthroughDisabled}
                  onClick={onShareWalkthrough}
                  type="button"
                >
                  <span className="wt-toc-title-row">
                    <span className="wt-toc-title">Share walkthrough</span>
                  </span>
                </button>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { agentLabel };
