import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { listGitLabReviewVersions } = require('../git-state/gitlab-review-history.cjs') as {
  listGitLabReviewVersions: (
    repoRoot: string,
    source: {
      host: string;
      number: number;
      projectPath: string;
      provider: 'gitlab';
      type: 'pull-request';
      url: string;
    },
  ) => Promise<
    ReadonlyArray<{
      id: string;
      isHead?: boolean;
      number?: number;
      range: { head: { commitId: string } };
    }>
  >;
};

const previousGlabPath = process.env.CODIFF_GLAB_PATH;

afterEach(() => {
  if (previousGlabPath == null) {
    delete process.env.CODIFF_GLAB_PATH;
  } else {
    process.env.CODIFF_GLAB_PATH = previousGlabPath;
  }
});

test('listGitLabReviewVersions projects glab version payloads into Core options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codiff-gitlab-history-'));
  const fakeGlabPath = join(directory, 'glab');
  await writeFile(
    fakeGlabPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const resource = args.find((arg) => arg.startsWith('/api/')) || args.at(-1) || '';
process.stdin.resume();
process.stdin.on('end', () => {
  if (resource.includes('/merge_requests/7/versions')) {
    process.stdout.write(JSON.stringify([
      {
        id: 2,
        head_commit_sha: ${JSON.stringify('c'.repeat(40))},
        base_commit_sha: ${JSON.stringify('a'.repeat(40))},
        start_commit_sha: ${JSON.stringify('a'.repeat(40))},
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 1,
        head_commit_sha: ${JSON.stringify('b'.repeat(40))},
        base_commit_sha: ${JSON.stringify('a'.repeat(40))},
        start_commit_sha: ${JSON.stringify('a'.repeat(40))},
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
});
`,
    'utf8',
  );
  await chmod(fakeGlabPath, 0o755);
  process.env.CODIFF_GLAB_PATH = fakeGlabPath;

  const versions = await listGitLabReviewVersions(directory, {
    host: 'gitlab.example.com',
    number: 7,
    projectPath: 'group/project',
    provider: 'gitlab',
    type: 'pull-request',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  });

  expect(versions.map((version) => version.id)).toEqual(['mr-base', '1', '2']);
  expect(versions[0]?.number).toBe(0);
  expect(versions[2]?.isHead).toBe(true);
  expect(versions[2]?.range.head.commitId).toBe('c'.repeat(40));
});
