import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createGlabGitLabTransport } = require('../git-state/glab-gitlab-transport.cjs') as {
  createGlabGitLabTransport: (options: {
    hostname: string;
    repoRoot: string;
  }) => {
    request: <T>(request: {
      method?: string;
      path: string;
      query?: Record<string, boolean | number | string>;
      body?: unknown;
    }) => Promise<T>;
  };
};

const previousGlabPath = process.env.CODIFF_GLAB_PATH;

afterEach(() => {
  if (previousGlabPath == null) {
    delete process.env.CODIFF_GLAB_PATH;
  } else {
    process.env.CODIFF_GLAB_PATH = previousGlabPath;
  }
});

test('createGlabGitLabTransport performs glab api requests through the injected executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-glab-transport-'));
  const fakeGlabPath = join(directory, 'glab');
  const callsPath = join(directory, 'calls.jsonl');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const callsPath = process.env.CODIFF_GLAB_TEST_CALLS;
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(callsPath, JSON.stringify({ args, input }) + '\\n');
  if (args.includes('/api/v4/projects/group%2Fproject/merge_requests/7/versions')) {
    process.stdout.write(JSON.stringify([
      {
        id: 1,
        head_commit_sha: 'b'.repeat(40),
        base_commit_sha: 'a'.repeat(40),
        start_commit_sha: 'a'.repeat(40),
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]));
  } else {
    process.stdout.write('{}');
  }
  process.exit(0);
});
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;
  process.env.CODIFF_GLAB_TEST_CALLS = callsPath;

  const transport = createGlabGitLabTransport({
    hostname: 'gitlab.example.com',
    repoRoot: directory,
  });
  const versions = await transport.request<Array<{ id: number }>>({
    path: '/api/v4/projects/group%2Fproject/merge_requests/7/versions',
  });
  expect(versions).toEqual([
    expect.objectContaining({ id: 1 }),
  ]);
});
