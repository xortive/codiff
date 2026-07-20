// @ts-check

/**
 * glab-backed GitLabTransport for local Codiff.
 * Keeps executable discovery, process spawning, and credentials in Electron.
 */

const { spawn } = require('node:child_process');
const { accessSync, constants } = require('node:fs');
const { homedir } = require('node:os');
const { delimiter, join } = require('node:path');

const GLAB_NOT_FOUND_CODE = 'GLAB_NOT_FOUND';
const GLAB_NOT_FOUND_MESSAGE =
  'GitLab support requires glab. Install glab, authenticate it, and verify `glab --version` works in Terminal. Codiff searches PATH, ~/.local/bin/glab, /opt/homebrew/bin/glab, and /usr/local/bin/glab. If glab is installed somewhere else, launch Codiff with `CODIFF_GLAB_PATH=/absolute/path/to/glab codiff -w`.';

/** @param {string} path */
const isExecutableFile = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** @param {string} command */
const findExecutableOnPath = (command) => {
  const pathValue = process.env.PATH ?? '';
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
};

/** @param {string} [detail] */
const createGlabNotFoundError = (detail) => {
  const error = /** @type {Error & { code?: string }} */ (
    new Error(detail ? `${GLAB_NOT_FOUND_MESSAGE} ${detail}` : GLAB_NOT_FOUND_MESSAGE)
  );
  error.code = GLAB_NOT_FOUND_CODE;
  return error;
};

const getGlabCommand = () => {
  const glabPath = process.env.CODIFF_GLAB_PATH?.trim();
  if (glabPath) {
    if (isExecutableFile(glabPath)) {
      return glabPath;
    }
    throw createGlabNotFoundError(
      `CODIFF_GLAB_PATH is set to ${JSON.stringify(glabPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('glab');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/glab'),
    '/opt/homebrew/bin/glab',
    '/usr/local/bin/glab',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createGlabNotFoundError();
};

/**
 * @param {string} hostname
 * @param {string} path
 * @param {Readonly<Record<string, boolean | number | string>> | undefined} query
 * @param {string | undefined} method
 * @param {unknown} body
 */
const createGlabApiArgs = (hostname, path, query, method, body) => {
  const url = new URL(path, 'https://gitlab.local');
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }
  const apiPath = url.pathname.replace(/^\/api\/v4(?=\/|$)/, '');
  const resource = `${apiPath || '/'}${url.search}`;
  /** @type {Array<string>} */
  const args = ['api', '--hostname', hostname, resource];
  if (method && method !== 'GET') {
    args.push('--method', method);
  }
  if (body != null) {
    args.push('--header', 'Content-Type: application/json', '--input', '-');
  }
  return args;
};

/**
 * @param {string} repoRoot
 * @param {string} hostname
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 */
const runGlabApi = (repoRoot, hostname, args, input) =>
  new Promise((resolve, reject) => {
    let command;
    try {
      command = getGlabCommand();
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(
        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
          ? createGlabNotFoundError()
          : error,
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() || `glab api exited with code ${code}.`,
          ),
        );
      }
    });
    if (input == null) {
      child.stdin.end();
    } else {
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    }
  });

/**
 * @param {{ hostname: string, repoRoot: string }} options
 */
const createGlabGitLabTransport = ({ hostname, repoRoot }) => {
  /**
   * @param {{
   *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
   *   path: string,
   *   query?: Readonly<Record<string, boolean | number | string>>,
   *   body?: unknown,
   * }} request
   */
  const requestText = async (request) => {
    const args = createGlabApiArgs(
      hostname,
      request.path,
      request.query,
      request.method,
      request.body,
    );
    return runGlabApi(repoRoot, hostname, args, request.body);
  };

  return {
    /**
     * @template T
     * @param {{
     *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
     *   path: string,
     *   query?: Readonly<Record<string, boolean | number | string>>,
     *   body?: unknown,
     * }} request
     * @returns {Promise<T>}
     */
    async request(request) {
      const text = await requestText(request);
      if (!text.trim()) {
        return /** @type {T} */ (null);
      }
      return /** @type {T} */ (JSON.parse(text));
    },
    requestText,
  };
};

module.exports = {
  GLAB_NOT_FOUND_CODE,
  createGlabGitLabTransport,
  createGlabNotFoundError,
  getGlabCommand,
};
