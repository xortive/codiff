// Provider-neutral review-structure classifier for pull and merge requests.

export type ClassifiedCommitRole =
  | 'chore'
  | 'docs'
  | 'feature'
  | 'fixup'
  | 'merge'
  | 'refactor'
  | 'revert'
  | 'review-response'
  | 'test'
  | 'unknown';

export type ClassifiedCommit = {
  authoredAt: string;
  authorName: string;
  body: string;
  isMerge: boolean;
  parents: ReadonlyArray<string>;
  role: ClassifiedCommitRole;
  sha: string;
  shortSha: string;
  subject: string;
  webUrl?: string;
};

export type MergeRequestReviewStrategy =
  | {
      commits: ReadonlyArray<ClassifiedCommit>;
      confidence: number;
      mode: 'commit-by-commit';
      reason: 'chapter-shaped' | 'explicit-description' | 'stacked-subjects' | 'user-override';
    }
  | {
      confidence: number;
      mode: 'whole-mr';
      reason:
        | 'default'
        | 'explicit-whole'
        | 'fixup-style'
        | 'review-response-style'
        | 'single-commit'
        | 'too-many-commits'
        | 'user-override';
    };

export type GitLabMergeRequestCommitLike = {
  authoredDate: string;
  authorName: string;
  message: string;
  parentIds: ReadonlyArray<string>;
  sha: string;
  shortSha: string;
  title: string;
  webUrl?: string;
};

export type ReviewStrategyCommitLike = GitLabMergeRequestCommitLike;

const explicitCommitByCommitPattern =
  /\b(?:review\s+commit(?:s)?(?:\s+by\s+commit|[- ]by[- ]commit)|please\s+review\s+each\s+commit|commit[- ]wise\s+review|stacked\s+diff|stacked\s+commits)\b/i;

const explicitWholePattern =
  /\b(?:review\s+as\s+a\s+whole|ignore\s+commits|squash\s+on\s+merge)\b/i;

const fixupSubjectPattern =
  /^(?:fixup!|squash!|amend!|wip\b|tmp\b|try\b|rework\b|review\s+feedback|pr\s+feedback|mr\s+feedback|nits?\b|typo\b|oops\b|cleanup\s+after|follow[- ]?up\b)/i;

const reviewResponseSubjectPattern =
  /^(?:address(?:ing)?\s+(?:review|comments?|feedback)|respond(?:ing)?\s+to\s+(?:review|comments?|feedback)|review\s+comments?)\b/i;

const conventionalCommitPattern =
  /^(?:feat|fix|refactor|test|docs|chore|perf|build|ci|style|revert)(?:\(.+\))?!?:/i;

const numberedStepPattern = /^(?:step\s+)?\d+[.):\-\s]/i;

const shortShaPattern = /\b[0-9a-f]{7,40}\b/gi;

const classifyCommitRole = (
  subject: string,
  parentIds: ReadonlyArray<string>,
): ClassifiedCommitRole => {
  if (parentIds.length > 1 || /^merge\b/i.test(subject)) {
    return 'merge';
  }
  if (fixupSubjectPattern.test(subject)) {
    return 'fixup';
  }
  if (reviewResponseSubjectPattern.test(subject)) {
    return 'review-response';
  }
  if (/^revert\b/i.test(subject) || subject.startsWith('Revert "')) {
    return 'revert';
  }
  if (/^(?:test|tests?)(?:\b|[:(\s])/i.test(subject) || /^test(?:\(.+\))?!?:/i.test(subject)) {
    return 'test';
  }
  if (/^(?:docs?)(?:\b|[:(\s])/i.test(subject) || /^docs?(?:\(.+\))?!?:/i.test(subject)) {
    return 'docs';
  }
  if (/^refactor(?:\b|[:(\s])/i.test(subject) || /^refactor(?:\(.+\))?!?:/i.test(subject)) {
    return 'refactor';
  }
  if (/^(?:chore|build|ci)(?:\b|[:(\s])/i.test(subject)) {
    return 'chore';
  }
  if (
    /^(?:feat|feature|add|implement)(?:\b|[:(\s])/i.test(subject) ||
    /^feat(?:\(.+\))?!?:/i.test(subject)
  ) {
    return 'feature';
  }
  return 'unknown';
};

const splitMessage = (message: string, title: string) => {
  const normalized = message.trim() || title.trim();
  const [subjectLine = title.trim() || 'Commit', ...rest] = normalized.split('\n');
  return {
    body: rest.join('\n').trim(),
    subject: subjectLine.trim() || title.trim() || 'Commit',
  };
};

export const classifyGitLabCommit = (commit: GitLabMergeRequestCommitLike): ClassifiedCommit => {
  const { body, subject } = splitMessage(commit.message, commit.title);
  const role = classifyCommitRole(subject, commit.parentIds);
  return {
    authoredAt: commit.authoredDate,
    authorName: commit.authorName,
    body,
    isMerge: role === 'merge' || commit.parentIds.length > 1,
    parents: commit.parentIds,
    role,
    sha: commit.sha,
    shortSha: commit.shortSha || commit.sha.slice(0, 8),
    subject,
    ...(commit.webUrl ? { webUrl: commit.webUrl } : {}),
  };
};

export const classifyReviewCommit = classifyGitLabCommit;

/**
 * Orders the commits in an MR from its base toward its head. GitLab's commits
 * endpoint does not promise the direction we need for a reviewer walkthrough,
 * so never use its response order as chronology.
 */
export const orderCommitsTopologically = <
  Commit extends {
    parentIds?: ReadonlyArray<string>;
    parents?: ReadonlyArray<string>;
    sha: string;
  },
>(
  commits: ReadonlyArray<Commit>,
): ReadonlyArray<Commit> => {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const inputIndex = new Map(commits.map((commit, index) => [commit.sha, index]));
  const children = new Map<string, Array<string>>();
  const remainingParents = new Map<string, number>();
  for (const commit of commits) {
    const parents = (commit.parents ?? commit.parentIds ?? []).filter((parent) =>
      bySha.has(parent),
    );
    remainingParents.set(commit.sha, parents.length);
    for (const parent of parents) {
      const siblings = children.get(parent) ?? [];
      siblings.push(commit.sha);
      children.set(parent, siblings);
    }
  }
  const ready = commits.filter((commit) => remainingParents.get(commit.sha) === 0);
  const result: Array<Commit> = [];
  while (ready.length > 0) {
    ready.sort((first, second) => inputIndex.get(first.sha)! - inputIndex.get(second.sha)!);
    const commit = ready.shift()!;
    result.push(commit);
    for (const childSha of children.get(commit.sha) ?? []) {
      const remaining = (remainingParents.get(childSha) ?? 1) - 1;
      remainingParents.set(childSha, remaining);
      if (remaining === 0) {
        ready.push(bySha.get(childSha)!);
      }
    }
  }
  // A malformed/cyclic response should remain reviewable rather than dropping commits.
  return result.length === commits.length
    ? result
    : [...result, ...commits.filter((commit) => !result.some((entry) => entry.sha === commit.sha))];
};

const descriptionListsCommits = (description: string, commits: ReadonlyArray<ClassifiedCommit>) => {
  if (!description.trim() || commits.length < 2) {
    return false;
  }
  const shortShas = new Set(commits.map((commit) => commit.shortSha.toLowerCase()));
  const fullShas = new Set(commits.map((commit) => commit.sha.toLowerCase()));
  const matches = description.toLowerCase().match(shortShaPattern) ?? [];
  const matched = new Set(
    matches.filter(
      (value) =>
        shortShas.has(value) ||
        fullShas.has(value) ||
        [...fullShas].some((sha) => sha.startsWith(value)),
    ),
  );
  if (matched.size >= 2) {
    return true;
  }
  const numberedLines = description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => numberedStepPattern.test(line));
  if (numberedLines.length < 2) {
    return false;
  }
  const subjectHits = numberedLines.filter((line) =>
    commits.some((commit) =>
      line.toLowerCase().includes(commit.subject.toLowerCase().slice(0, 24)),
    ),
  ).length;
  return subjectHits >= 2;
};

const looksChapterShaped = (commits: ReadonlyArray<ClassifiedCommit>) => {
  if (commits.length < 2) {
    return false;
  }
  const intentional = commits.filter(
    (commit) =>
      commit.role === 'feature' ||
      commit.role === 'refactor' ||
      commit.role === 'test' ||
      commit.role === 'docs' ||
      conventionalCommitPattern.test(commit.subject) ||
      numberedStepPattern.test(commit.subject),
  );
  const uniqueSubjects = new Set(commits.map((commit) => commit.subject.toLowerCase()));
  // GitLab commit subjects are often descriptive without using Conventional
  // Commits. Treat a short, distinct, non-fixup history as chapter-shaped too.
  return (
    uniqueSubjects.size >= 2 &&
    (intentional.length >= Math.ceil(commits.length * 0.5) ||
      uniqueSubjects.size === commits.length)
  );
};

export const classifyMergeRequestReviewStrategy = (input: {
  commits: ReadonlyArray<GitLabMergeRequestCommitLike>;
  description?: string;
  title?: string;
}): MergeRequestReviewStrategy => {
  const classified = input.commits.map(classifyGitLabCommit);
  const nonMerge = classified.filter((commit) => !commit.isMerge);
  const text = `${input.title ?? ''}\n${input.description ?? ''}`;
  const fixupDensity =
    nonMerge.filter((commit) => commit.role === 'fixup' || commit.role === 'review-response')
      .length / Math.max(nonMerge.length, 1);

  if (explicitWholePattern.test(text) && !explicitCommitByCommitPattern.test(text)) {
    return { confidence: 0.95, mode: 'whole-mr', reason: 'explicit-whole' };
  }
  if (explicitCommitByCommitPattern.test(text) || descriptionListsCommits(text, nonMerge)) {
    return {
      commits: nonMerge,
      confidence: 0.95,
      mode: 'commit-by-commit',
      reason: 'explicit-description',
    };
  }
  if (nonMerge.length <= 1) {
    return { confidence: 0.99, mode: 'whole-mr', reason: 'single-commit' };
  }
  if (fixupDensity >= 0.4) {
    const reviewResponseOnly =
      nonMerge.filter((commit) => commit.role === 'review-response').length /
        Math.max(nonMerge.length, 1) >=
      0.4;
    return {
      confidence: 0.85,
      mode: 'whole-mr',
      reason: reviewResponseOnly ? 'review-response-style' : 'fixup-style',
    };
  }
  if (nonMerge.length > 20) {
    return { confidence: 0.7, mode: 'whole-mr', reason: 'too-many-commits' };
  }
  if (looksChapterShaped(nonMerge)) {
    return {
      commits: nonMerge,
      confidence: 0.75,
      mode: 'commit-by-commit',
      reason: conventionalCommitPattern.test(nonMerge[0]?.subject ?? '')
        ? 'stacked-subjects'
        : 'chapter-shaped',
    };
  }
  return { confidence: 0.55, mode: 'whole-mr', reason: 'default' };
};

export const classifyReviewStrategy = classifyMergeRequestReviewStrategy;

export const reviewStructureFromStrategy = (
  strategy: MergeRequestReviewStrategy,
): 'commit-by-commit' | 'whole-mr' => strategy.mode;

export const overrideMergeRequestReviewStrategy = (
  strategy: MergeRequestReviewStrategy,
  mode: 'commit-by-commit' | 'whole-mr',
  sourceCommits: ReadonlyArray<GitLabMergeRequestCommitLike> = [],
): MergeRequestReviewStrategy => {
  if (mode === 'whole-mr') {
    return {
      confidence: 1,
      mode: 'whole-mr',
      reason: 'user-override',
    };
  }
  const commits =
    strategy.mode === 'commit-by-commit'
      ? strategy.commits
      : sourceCommits.map(classifyGitLabCommit).filter((commit) => !commit.isMerge);
  return {
    commits,
    confidence: 1,
    mode: 'commit-by-commit',
    reason: 'user-override',
  };
};

/** Cache identity segment for a version-comparison walkthrough. */
export const versionCompareReviewStructureKey = (
  fromId: string,
  toId: string,
  structure: 'commit-by-commit' | 'whole-diff' = 'whole-diff',
) => `version-compare:${fromId}:${toId}:${structure}`;
