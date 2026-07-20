// @ts-check

/**
 * Local GitHub review-history adapter over gh transport + @nkzw/codiff-github.
 *
 * Process spawning (gh, git fetch) stays here. Pure force-push timeline and
 * compare/evolution projection live in the package.
 */

const { spawn } = require('node:child_process');
const { createGhGitHubTransport } = require('./gh-github-transport.cjs');
const { gitOrEmpty } = require('../common.cjs');
const { readRangeState } = require('../commit.cjs');
const { loadGitHubHistory } = require('../../github-history-bridge.cjs');

/**
 * @typedef {import('../../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../../core/types.ts').ReviewEvolutionUnit} ReviewEvolutionUnit
 * @typedef {import('../../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../../core/types.ts').ReviewVersionOption} ReviewVersionOption
 * @typedef {Extract<ReviewSource, { type: 'pull-request' }>} PullRequestSource
 */

/**
 * @param {PullRequestSource} source
 */
const assertGitHubSource = (source) => {
  if (source.provider && source.provider !== 'github') {
    throw new Error('GitHub review history requires a GitHub pull request source.');
  }
  if (!source.owner?.trim() || !source.repo?.trim()) {
    throw new Error('GitHub review history requires owner and repo on the pull request source.');
  }
  if (!source.number || !Number.isInteger(source.number) || source.number <= 0) {
    throw new Error('GitHub review history requires a pull request number.');
  }
  return {
    headSha: source.headSha ?? null,
    number: source.number,
    owner: source.owner,
    repo: source.repo,
  };
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<string>}
 */
const runGit = (repoRoot, args) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() || `git exited with code ${code}.`,
          ),
        );
      }
    });
  });

/**
 * @param {string} sha
 */
const shortSha = (sha) => sha.slice(0, 7);

/**
 * @param {string} repoRoot
 * @param {string} sha
 */
const ensureCommitAvailable = async (repoRoot, sha) => {
  const existing = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
  ).trim();
  if (existing) {
    return existing;
  }
  try {
    await runGit(repoRoot, ['fetch', '--no-tags', 'origin', sha]);
  } catch {
    try {
      await runGit(repoRoot, ['fetch', '--no-tags', '--depth=1', 'origin', sha]);
    } catch {
      // Fall through.
    }
  }
  const after = (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
  ).trim();
  if (!after) {
    throw new Error(
      `Commit ${shortSha(sha)} is not available locally. Fetch the pull request refs or run \`git fetch origin ${sha}\`.`,
    );
  }
  return after;
};

/**
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 */
const readCommitStack = async (repoRoot, base, head) => {
  const raw = await gitOrEmpty(repoRoot, [
    'log',
    '--format=%H%x00%P%x00%an%x00%aI%x00%s',
    `${base}..${head}`,
  ]);
  if (!raw.trim()) {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .map((line) => {
      const [sha, parents, authorName, authoredAt, subject] = line.split('\0');
      return {
        authorName: authorName || 'Unknown',
        authoredAt: authoredAt || new Date(0).toISOString(),
        parentIds: parents ? parents.split(' ').filter(Boolean) : [],
        sha,
        shortSha: shortSha(sha),
        subject: subject || sha.slice(0, 7),
      };
    })
    .reverse();
};

/**
 * @param {string} repoRoot
 */
/**
 * @param {string} repoRoot
 * @param {string} sha
 */
const readCommitMeta = async (repoRoot, sha) => {
  const raw = (
    await gitOrEmpty(repoRoot, ['log', '-1', '--format=%H%x00%P%x00%an%x00%aI%x00%s', sha])
  ).trim();
  if (!raw) {
    throw new Error(`Commit ${shortSha(sha)} metadata is unavailable.`);
  }
  const [fullSha, parents, authorName, authoredAt, subject] = raw.split('\0');
  return {
    authorName: authorName || 'Unknown',
    authoredAt: authoredAt || new Date(0).toISOString(),
    parentIds: parents ? parents.split(' ').filter(Boolean) : [],
    sha: fullSha || sha,
    shortSha: shortSha(fullSha || sha),
    subject: subject || shortSha(fullSha || sha),
  };
};

/**
 * @param {string} repoRoot
 * @param {string} ancestor
 * @param {string} descendant
 */
const isAncestor = async (repoRoot, ancestor, descendant) => {
  const code = await new Promise((resolve) => {
    const child = spawn('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(1));
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });
  return code === 0;
};

/**
 * @param {string} repoRoot
 */
const createLocalGit = (repoRoot) => ({
  ensureCommit: (/** @type {string} */ sha) => ensureCommitAvailable(repoRoot, sha),
  /**
   * @param {string} ancestor
   * @param {string} descendant
   */
  isAncestor: (ancestor, descendant) => isAncestor(repoRoot, ancestor, descendant),
  /**
   * @param {string} left
   * @param {string} right
   */
  mergeBase: async (left, right) => {
    const base = (await gitOrEmpty(repoRoot, ['merge-base', left, right])).trim();
    if (!base) {
      throw new Error(`No merge base is available for ${shortSha(left)} and ${shortSha(right)}.`);
    }
    return base;
  },
  /**
   * @param {string} sha
   */
  readCommitDiff: async (sha) => {
    const parent = (
      await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^`])
    ).trim();
    if (!parent) {
      const state = await readRangeState(repoRoot, `${sha}^`, sha, false);
      return state.files;
    }
    const state = await readRangeState(repoRoot, parent, sha, false);
    return state.files;
  },
  /**
   * @param {string} sha
   */
  readCommitMeta: (sha) => readCommitMeta(repoRoot, sha),
  /**
   * @param {string} base
   * @param {string} head
   */
  readCommitStack: (base, head) => readCommitStack(repoRoot, base, head),
  /**
   * @param {string} base
   * @param {string} head
   * @param {boolean} symmetric
   */
  readRangeFiles: async (base, head, symmetric) => {
    const state = await readRangeState(repoRoot, base, head, symmetric);
    return state.files;
  },
});

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 */
const listGitHubReviewVersions = async (repoRoot, source) => {
  const pull = assertGitHubSource(source);
  const transport = createGhGitHubTransport({ repoRoot });
  const github = /** @type {any} */ (await loadGitHubHistory());
  return github.listGitHubReviewVersions({ git: createLocalGit(repoRoot), pull, transport });
};

/**
 * @param {string} repoRoot
 * @param {PullRequestSource} source
 * @param {{ fromId: string, toId: string }} range
 * @param {ReadonlyArray<ReviewVersionOption>} versions
 */
const compareGitHubReviewVersions = async (repoRoot, source, range, versions) => {
  const pull = assertGitHubSource(source);
  const github = await loadGitHubHistory();
  return github.compareGitHubReviewVersions({
    git: createLocalGit(repoRoot),
    pull,
    range,
    versions,
  });
};

/**
 * @param {string} repoRoot
 * @param {ReviewEvolutionUnit} unit
 * @returns {Promise<ReadonlyArray<ChangedFile>>}
 */
const loadGitHubVersionCommitUnitDiff = async (repoRoot, unit) => {
  const github = await loadGitHubHistory();
  return github.loadGitHubVersionCommitUnitDiff({
    git: createLocalGit(repoRoot),
    unit,
  });
};

module.exports = {
  compareGitHubReviewVersions,
  listGitHubReviewVersions,
  loadGitHubVersionCommitUnitDiff,
};
