// @ts-check

/**
 * gh-backed GitHubTransport for local Codiff.
 * Keeps executable discovery, process spawning, and credentials in Electron.
 */

const { spawn } = require('node:child_process');
const { accessSync, constants } = require('node:fs');
const { homedir } = require('node:os');
const { delimiter, join } = require('node:path');

const GH_NOT_FOUND_CODE = 'GH_NOT_FOUND';
const GH_NOT_FOUND_MESSAGE =
  'GitHub support requires gh. Install gh, authenticate it, and verify `gh --version` works in Terminal. Codiff searches PATH, ~/.local/bin/gh, /opt/homebrew/bin/gh, and /usr/local/bin/gh. If gh is installed somewhere else, launch Codiff with `CODIFF_GH_PATH=/absolute/path/to/gh codiff`.';

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
const createGhNotFoundError = (detail) => {
  const error = /** @type {Error & { code?: string }} */ (
    new Error(detail ? `${GH_NOT_FOUND_MESSAGE} ${detail}` : GH_NOT_FOUND_MESSAGE)
  );
  error.code = GH_NOT_FOUND_CODE;
  return error;
};

const getGhCommand = () => {
  const ghPath = process.env.CODIFF_GH_PATH?.trim();
  if (ghPath) {
    if (isExecutableFile(ghPath)) {
      return ghPath;
    }
    throw createGhNotFoundError(
      `CODIFF_GH_PATH is set to ${JSON.stringify(ghPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('gh');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createGhNotFoundError();
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @returns {Promise<string>}
 */
const runGhApi = (repoRoot, args, input) =>
  new Promise((resolve, reject) => {
    let command;
    try {
      command = getGhCommand();
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(command, ['api', ...args], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(
        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
          ? createGhNotFoundError()
          : error,
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() || `gh api exited with code ${code}.`,
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
 * @param {{ repoRoot: string }} options
 */
const createGhGitHubTransport = ({ repoRoot }) => {
  /**
   * @param {{
   *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
   *   path: string,
   *   query?: Readonly<Record<string, boolean | number | string>>,
   *   body?: unknown,
   *   paginate?: boolean,
   * }} request
   */
  const requestText = async (request) => {
    /** @type {Array<string>} */
    const args = [];
    if (request.paginate) {
      args.push('--paginate');
    }
    if (request.method && request.method !== 'GET') {
      args.push('--method', request.method);
    }
    let path = request.path.startsWith('/') ? request.path : `/${request.path}`;
    if (request.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query)) {
        params.set(key, String(value));
      }
      const query = params.toString();
      if (query) {
        path = `${path}${path.includes('?') ? '&' : '?'}${query}`;
      }
    }
    args.push(path);
    if (request.body != null) {
      args.push('--input', '-');
    }
    return runGhApi(repoRoot, args, request.body);
  };

  return {
    /**
     * @template T
     * @param {{
     *   method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
     *   path: string,
     *   query?: Readonly<Record<string, boolean | number | string>>,
     *   body?: unknown,
     *   paginate?: boolean,
     * }} request
     * @returns {Promise<T>}
     */
    async request(request) {
      const text = await requestText(request);
      if (!text.trim()) {
        return /** @type {T} */ (null);
      }
      // --paginate may emit concatenated JSON arrays; join them.
      if (request.paginate && text.includes(']\n[')) {
        const chunks = text
          .split(/\n(?=\[)/)
          .map((chunk) => JSON.parse(chunk))
          .flat();
        return /** @type {T} */ (chunks);
      }
      return /** @type {T} */ (JSON.parse(text));
    },
    requestText,
  };
};

module.exports = {
  GH_NOT_FOUND_CODE,
  createGhGitHubTransport,
  createGhNotFoundError,
  getGhCommand,
};
