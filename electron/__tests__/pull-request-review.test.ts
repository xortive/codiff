import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { removeGitTestDirectory } from '../../core/__tests__/helpers/git.ts';

const require = createRequire(import.meta.url);
const { readPullRequestDiff, submitPullRequestReview } =
  require('../git-state/pull-request.cjs') as {
    readPullRequestDiff: (
      repoRoot: string,
      pullRequest: { number: number; owner: string; repo: string; url: string },
    ) => Promise<string>;
    submitPullRequestReview: (
      launchPath: string,
      request: {
        body?: string;
        comments: ReadonlyArray<Record<string, unknown>>;
        event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
        source: {
          provider: 'github';
          type: 'pull-request';
          url: string;
        };
      },
    ) => Promise<void>;
  };

const execFileAsync = promisify(execFile);

test('submits normalized GitHub review payloads through the GitHub CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-review-'));
  const repo = join(directory, 'repo');
  const fakeBin = join(directory, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const callsPath = join(directory, 'calls.jsonl');
  const previousPath = process.env.PATH;
  const previousCallsPath = process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS;

  try {
    await Promise.all([mkdir(repo), mkdir(fakeBin)]);
    await execFileAsync('git', ['-C', repo, 'init']);
    await execFileAsync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:nkzw-tech/codiff.git',
    ]);
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  appendFileSync(
    process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS,
    JSON.stringify({ args, input }) + '\\n',
  );
  process.stdout.write('{}');
});
`,
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS = callsPath;

    const source = {
      provider: 'github' as const,
      type: 'pull-request' as const,
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    };

    await submitPullRequestReview(repo, {
      comments: [
        {
          body: 'Please keep this explicit.',
          filePath: 'src/app.ts',
          lineNumber: 7,
          side: 'additions',
        },
      ],
      event: 'COMMENT',
      source,
    });
    await submitPullRequestReview(repo, {
      body: '  General feedback.  ',
      comments: [],
      event: 'COMMENT',
      source,
    });
    await expect(
      submitPullRequestReview(repo, {
        body: '   ',
        comments: [],
        event: 'COMMENT',
        source,
      }),
    ).rejects.toThrow('A comment review requires an inline comment or a review comment.');
    await submitPullRequestReview(repo, {
      comments: [],
      event: 'REQUEST_CHANGES',
      source,
    });

    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: ReadonlyArray<string>;
            input: string;
          },
      );
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toContain('repos/nkzw-tech/codiff/pulls/12/reviews');
    }
    expect(JSON.parse(calls[0].input)).toEqual({
      body: '',
      comments: [
        {
          body: 'Please keep this explicit.',
          line: 7,
          path: 'src/app.ts',
          side: 'RIGHT',
        },
      ],
      event: 'COMMENT',
    });
    expect(JSON.parse(calls[1].input)).toEqual({
      body: 'General feedback.',
      comments: [],
      event: 'COMMENT',
    });
    expect(JSON.parse(calls[2].input)).toEqual({
      body: 'Requesting changes.',
      comments: [],
      event: 'REQUEST_CHANGES',
    });
  } finally {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousCallsPath == null) {
      delete process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS;
    } else {
      process.env.CODIFF_GITHUB_REVIEW_TEST_CALLS = previousCallsPath;
    }
    await removeGitTestDirectory(directory);
  }
});

test('falls back to per-file patches when GitHub rejects an oversized aggregate diff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-pull-request-diff-'));
  const fakeBin = join(directory, 'bin');
  const fakeGh = join(fakeBin, 'gh');
  const previousPath = process.env.PATH;

  try {
    await mkdir(fakeBin);
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
process.stderr.write('gh: Sorry, the diff exceeded the maximum number of lines (20000) (HTTP 406) when trying to use this endpoint.\\n');
process.exit(1);
`,
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

    await expect(
      readPullRequestDiff(directory, {
        number: 12,
        owner: 'nkzw-tech',
        repo: 'codiff',
        url: 'https://github.com/nkzw-tech/codiff/pull/12',
      }),
    ).resolves.toBe('');
  } finally {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    await removeGitTestDirectory(directory);
  }
});
