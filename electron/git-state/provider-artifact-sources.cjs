// @ts-check

const { getCommandActionSignal } = require('../command-log.cjs');
const { loadGitHubHistory } = require('../github-history-bridge.cjs');
const { loadGitLabHistory } = require('../gitlab-history-bridge.cjs');
const { createGhGitHubTransport } = require('./github-history/gh-github-transport.cjs');
const { createGlabGitLabTransport } = require('./glab-gitlab-transport.cjs');
const { parseReviewUrl } = require('../review-source.cjs');
const { createNativeCommitArtifactSource } = require('./commit-artifacts.cjs');
const { getComparisonArtifactRun } = require('./review-artifact-run.cjs');

const githubRangeDiffSemantics = 'github-repository-compare-v1';
const gitlabRangeDiffSemantics = 'gitlab-repository-compare-straight-v1';

/** @param {import('../../core/types.ts').ResolvedReviewSource} source */
const getProviderIdentity = (source) => {
  if (source.type !== 'pull-request') {
    return null;
  }
  const parsed = parseReviewUrl(source.url);
  const provider = source.provider || parsed?.provider;
  if (provider === 'gitlab') {
    const host = source.host || (parsed?.provider === 'gitlab' ? parsed.host : undefined);
    const projectPath =
      source.projectPath || (parsed?.provider === 'gitlab' ? parsed.projectPath : undefined);
    return host && projectPath
      ? {
          headSha: source.headSha,
          host,
          number: source.number || (parsed?.provider === 'gitlab' ? parsed.number : undefined),
          projectPath,
          provider: /** @type {const} */ ('gitlab'),
        }
      : null;
  }
  if (provider === 'github') {
    const projectParts = source.projectPath?.split('/') || [];
    const owner =
      source.owner || projectParts[0] || (parsed?.provider === 'github' ? parsed.owner : undefined);
    const repo =
      source.repo ||
      projectParts.slice(1).join('/') ||
      (parsed?.provider === 'github' ? parsed.repo : undefined);
    return owner && repo
      ? {
          host: source.host || 'github.com',
          headSha: source.headSha,
          number: source.number || (parsed?.provider === 'github' ? parsed.number : undefined),
          owner,
          provider: /** @type {const} */ ('github'),
          repo,
        }
      : null;
  }
  return null;
};

/**
 * One native-first commit-content adapter for every resolved review source.
 * Provider-specific modules retain metadata and mutations; exact bytes use
 * this common shape after the source has been normalized.
 * @param {string} repoRoot
 * @param {import('../../core/types.ts').ResolvedReviewSource} source
 */
const createCommitContentAdapter = (repoRoot, source) => {
  const provider = getProviderIdentity(source);
  if (provider?.provider === 'github') {
    return {
      identity: githubArtifactProject(provider),
      readFileBlobs: (requests) => readGitHubFileBlobArtifacts(repoRoot, provider, requests),
    };
  }
  if (provider?.provider === 'gitlab') {
    return {
      identity: gitlabArtifactProject(provider),
      readFileBlobs: (requests) => readGitLabFileBlobArtifacts(repoRoot, provider, requests),
    };
  }
  const identity = { host: 'local', project: repoRoot, provider: /** @type {const} */ ('git') };
  return {
    identity,
    readFileBlobs: (requests) => readNativeFileBlobArtifacts(repoRoot, identity, requests),
  };
};

/** @param {{host?: string, owner: string, repo: string}} pull */
const githubArtifactProject = (pull) => ({
  host: pull.host || 'github.com',
  project: `${pull.owner}/${pull.repo}`,
  provider: /** @type {const} */ ('github'),
});

/** @param {{host: string, projectPath: string}} mergeRequest */
const gitlabArtifactProject = (mergeRequest) => ({
  host: mergeRequest.host,
  project: mergeRequest.projectPath,
  provider: /** @type {const} */ ('gitlab'),
});

/**
 * @param {string} repoRoot
 * @param {{host?: string, number: number, owner: string, repo: string}} pull
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const createGitHubArtifactBackend = (repoRoot, pull, transport) => ({
  createSource: async () =>
    (await loadGitHubHistory()).createGitHubArtifactSource({
      project: githubArtifactProject(pull),
      pull,
      transport: transport || createGhGitHubTransport({ repoRoot }),
    }),
  diffSemantics: githubRangeDiffSemantics,
  identity: 'github-api',
  provenanceKind: /** @type {const} */ ('github-api'),
});

/**
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const createGitLabArtifactBackend = (repoRoot, mergeRequest, transport) => ({
  createSource: async () =>
    (await loadGitLabHistory()).createGitLabArtifactSource({
      project: gitlabArtifactProject(mergeRequest),
      projectPath: mergeRequest.projectPath,
      transport: transport || createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot }),
    }),
  diffSemantics: gitlabRangeDiffSemantics,
  identity: 'gitlab-api',
  provenanceKind: /** @type {const} */ ('gitlab-api'),
});

/** @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} control */
const withActionSignal = (control) => {
  const signal = control.signal || getCommandActionSignal();
  return signal && signal !== control.signal ? { ...control, signal } : control;
};

/** @param {{path: string, ref: string}} request */
const fileBlobRequestKey = (request) => `${request.ref}:${request.path}`;

/**
 * Provider fallback is allowed only while the logical review still points at
 * the immutable head captured by RepositoryState. Native hits stay offline.
 * @param {ReturnType<typeof createGhGitHubTransport>} transport
 * @param {{headSha?: string, number?: number, owner: string, repo: string}} pull
 * @param {AbortSignal} signal
 */
const assertGitHubHeadCurrent = async (transport, pull, signal) => {
  if (!pull.headSha || !pull.number) return;
  const metadata = await transport.request({
    path: `repos/${pull.owner}/${pull.repo}/pulls/${pull.number}`,
    signal,
  });
  signal.throwIfAborted();
  if (metadata?.head?.sha !== pull.headSha) {
    throw new Error('The pull request head changed. Refresh before loading exact content.');
  }
};

/**
 * @param {ReturnType<typeof createGlabGitLabTransport>} transport
 * @param {{headSha?: string, number?: number, projectPath: string}} mergeRequest
 * @param {AbortSignal} signal
 */
const assertGitLabHeadCurrent = async (transport, mergeRequest, signal) => {
  if (!mergeRequest.headSha || !mergeRequest.number) return;
  const metadata = await transport.request({
    path: `projects/${encodeURIComponent(mergeRequest.projectPath)}/merge_requests/${
      mergeRequest.number
    }`,
    signal,
  });
  signal.throwIfAborted();
  const headSha = metadata?.diff_refs?.head_sha || metadata?.sha;
  if (headSha !== mergeRequest.headSha) {
    throw new Error('The merge request head changed. Refresh before loading exact content.');
  }
};

/**
 * Resolve immutable ref+path coordinates from native Git in one bounded batch.
 * @param {string} repoRoot
 * @param {import('../../core/lib/review-artifacts.ts').ReviewArtifactProject} project
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 */
const readNativeFileBlobArtifacts = async (repoRoot, project, requests) => {
  const signal =
    requests.find((request) => request.signal)?.signal ||
    getCommandActionSignal() ||
    new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  return createNativeCommitArtifactSource(repoRoot, project, {
    maxBlobArtifactBytes: maxBytes,
  }).readFileBlobs(coordinates, signal);
};

/**
 * Resolve GitHub ref+path coordinates through native Git first and the
 * canonical API Artifact Source second. Returned bytes carry Git object IDs.
 * @param {string} repoRoot
 * @param {{headSha?: string, host?: string, number?: number, owner: string, repo: string}} pull
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const readGitHubFileBlobArtifacts = async (repoRoot, pull, requests, transport) => {
  const signal =
    requests.find((request) => request.signal)?.signal ||
    getCommandActionSignal() ||
    new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const project = githubArtifactProject(pull);
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  let local = new Map();
  try {
    local = await readNativeFileBlobArtifacts(
      repoRoot,
      project,
      coordinates.map((coordinate) => ({ ...coordinate, signal })),
    );
  } catch {
    signal.throwIfAborted();
  }
  const providerTransport = transport || createGhGitHubTransport({ repoRoot });
  await assertGitHubHeadCurrent(providerTransport, pull, signal);
  const missing = coordinates.filter((coordinate) => !local.has(fileBlobRequestKey(coordinate)));
  if (missing.length === 0) return local;
  const source = (await loadGitHubHistory()).createGitHubArtifactSource({
    maxBlobArtifactBytes: maxBytes,
    project,
    pull: { ...pull, number: pull.number || 0 },
    transport: providerTransport,
  });
  const provider = (await source.readFileBlobs?.(missing, signal)) || new Map();
  return new Map([...local, ...provider]);
};

/** @param {string} repoRoot @param {{host?: string, number?: number, owner: string, repo: string}} pull @param {{maxBytes: number, path: string, ref: string, signal?: AbortSignal}} request @param {ReturnType<typeof createGhGitHubTransport>} [transport] */
const readGitHubFileBlobArtifact = async (repoRoot, pull, request, transport) =>
  (await readGitHubFileBlobArtifacts(repoRoot, pull, [request], transport)).get(
    fileBlobRequestKey(request),
  );

/**
 * Resolve GitLab ref+path coordinates through native Git first and the
 * canonical API Artifact Source second. Returned bytes carry Git object IDs.
 * @param {string} repoRoot
 * @param {{headSha?: string, host: string, number?: number, projectPath: string}} mergeRequest
 * @param {ReadonlyArray<{maxBytes: number, path: string, ref: string, signal?: AbortSignal}>} requests
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const readGitLabFileBlobArtifacts = async (repoRoot, mergeRequest, requests, transport) => {
  const signal =
    requests.find((request) => request.signal)?.signal ||
    getCommandActionSignal() ||
    new AbortController().signal;
  const coordinates = requests.map(({ maxBytes, path, ref }) => ({ maxBytes, path, ref }));
  const project = gitlabArtifactProject(mergeRequest);
  const maxBytes = Math.max(0, ...coordinates.map((request) => request.maxBytes));
  let local = new Map();
  try {
    local = await readNativeFileBlobArtifacts(
      repoRoot,
      project,
      coordinates.map((coordinate) => ({ ...coordinate, signal })),
    );
  } catch {
    signal.throwIfAborted();
  }
  const providerTransport =
    transport || createGlabGitLabTransport({ hostname: mergeRequest.host, repoRoot });
  await assertGitLabHeadCurrent(providerTransport, mergeRequest, signal);
  const missing = coordinates.filter((coordinate) => !local.has(fileBlobRequestKey(coordinate)));
  if (missing.length === 0) return local;
  const source = (await loadGitLabHistory()).createGitLabArtifactSource({
    maxBlobArtifactBytes: maxBytes,
    project,
    projectPath: mergeRequest.projectPath,
    transport: providerTransport,
  });
  const provider = (await source.readFileBlobs?.(missing, signal)) || new Map();
  return new Map([...local, ...provider]);
};

/** @param {string} repoRoot @param {{host: string, projectPath: string}} mergeRequest @param {{maxBytes: number, path: string, ref: string, signal?: AbortSignal}} request @param {ReturnType<typeof createGlabGitLabTransport>} [transport] */
const readGitLabFileBlobArtifact = async (repoRoot, mergeRequest, request, transport) =>
  (await readGitLabFileBlobArtifacts(repoRoot, mergeRequest, [request], transport)).get(
    fileBlobRequestKey(request),
  );

/**
 * Prefer bounded native Git and route only unavailable or incomplete keys to
 * the canonical GitHub API Artifact Source.
 * @param {string} repoRoot
 * @param {{host?: string, number: number, owner: string, repo: string}} pull
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const getGitHubComparisonArtifactRun = (repoRoot, pull, control = {}, transport) =>
  getComparisonArtifactRun(repoRoot, githubArtifactProject(pull), withActionSignal(control), {
    fallbackSource: createGitHubArtifactBackend(repoRoot, pull, transport),
  });

/**
 * Acquire an explicit GitHub range through its canonical API source. This is
 * used before local review refs are available and populates the provider cache
 * consumed by later hybrid Comparison Runs.
 * @param {string} repoRoot
 * @param {{host?: string, number: number, owner: string, repo: string}} pull
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGhGitHubTransport>} [transport]
 */
const getGitHubProviderArtifactRun = (repoRoot, pull, control = {}, transport) =>
  getComparisonArtifactRun(repoRoot, githubArtifactProject(pull), withActionSignal(control), {
    source: createGitHubArtifactBackend(repoRoot, pull, transport),
  });

/**
 * Prefer bounded native Git and route only unavailable or incomplete keys to
 * the canonical GitLab API Artifact Source.
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const getGitLabComparisonArtifactRun = (repoRoot, mergeRequest, control = {}, transport) =>
  getComparisonArtifactRun(
    repoRoot,
    gitlabArtifactProject(mergeRequest),
    withActionSignal(control),
    { fallbackSource: createGitLabArtifactBackend(repoRoot, mergeRequest, transport) },
  );

/**
 * Acquire an explicit GitLab range through its canonical API source. This is
 * used before local review refs are available and populates the provider cache
 * consumed by later hybrid Comparison Runs.
 * @param {string} repoRoot
 * @param {{host: string, projectPath: string}} mergeRequest
 * @param {{comparisonRun?: {artifactRuns?: Map<string, Promise<any>>}, signal?: AbortSignal}} [control]
 * @param {ReturnType<typeof createGlabGitLabTransport>} [transport]
 */
const getGitLabProviderArtifactRun = (repoRoot, mergeRequest, control = {}, transport) =>
  getComparisonArtifactRun(
    repoRoot,
    gitlabArtifactProject(mergeRequest),
    withActionSignal(control),
    { source: createGitLabArtifactBackend(repoRoot, mergeRequest, transport) },
  );

module.exports = {
  createCommitContentAdapter,
  createGitHubArtifactBackend,
  createGitLabArtifactBackend,
  getProviderIdentity,
  getGitHubComparisonArtifactRun,
  getGitHubProviderArtifactRun,
  getGitLabComparisonArtifactRun,
  getGitLabProviderArtifactRun,
  githubArtifactProject,
  githubRangeDiffSemantics,
  gitlabArtifactProject,
  gitlabRangeDiffSemantics,
  readGitHubFileBlobArtifact,
  readGitHubFileBlobArtifacts,
  readGitLabFileBlobArtifact,
  readGitLabFileBlobArtifacts,
  readNativeFileBlobArtifacts,
};
