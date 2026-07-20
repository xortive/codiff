import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

test('listGitHubReviewVersions builds head timeline labels without GitLab version numbers', async () => {
  const { chmod, mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = await mkdtemp(join(tmpdir(), 'codiff-gh-history-'));
  const fakeGh = join(directory, 'gh');
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const current = 'c'.repeat(40);
  const base = '0'.repeat(40);
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const pathArg = args.find((a) => a.startsWith('/repos/')) || '';
process.stdin.resume();
process.stdin.on('end', () => {
  if (pathArg.includes('/timeline')) {
    process.stdout.write(JSON.stringify([
      {
        event: 'head_ref_force_pushed',
        before: '${before}',
        after: '${after}',
        created_at: '2026-01-02T00:00:00.000Z',
        actor: { login: 'ada' },
      },
    ]));
  } else if (pathArg.includes('/pulls/')) {
    process.stdout.write(JSON.stringify({
      head: { sha: '${current}' },
      base: { sha: '${base}' },
    }));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
});
`,
    'utf8',
  );
  await chmod(fakeGh, 0o755);
  const previous = process.env.CODIFF_GH_PATH;
  process.env.CODIFF_GH_PATH = fakeGh;
  try {
    const require = createRequire(import.meta.url);
    const { listGitHubReviewVersions } =
      require('../git-state/github-history/github-review-history.cjs') as {
        listGitHubReviewVersions: (
          repoRoot: string,
          source: {
            number: number;
            owner: string;
            provider: 'github';
            repo: string;
            type: 'pull-request';
            url: string;
          },
        ) => Promise<{
          versions: ReadonlyArray<{ id: string; range: { head: { label: { text: string } } } }>;
          warning: string | null;
        }>;
      };
    const { versions, warning } = await listGitHubReviewVersions(directory, {
      number: 12,
      owner: 'nkzw-tech',
      provider: 'github',
      repo: 'codiff',
      type: 'pull-request',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    });
    expect(warning).toBeNull();
    expect(versions.map((v) => v.id)).toEqual([before, after, current]);
    const labels = versions.map((v) => v.range.head.label.text);
    expect(labels.some((label) => label.startsWith('Head ·'))).toBe(true);
    expect(labels.some((label) => label.startsWith('Force-push ·'))).toBe(true);
    expect(labels.at(-1)).toBe('Current head');
    expect(labels.every((label) => !/^v\d+/.test(label))).toBe(true);
  } finally {
    if (previous == null) delete process.env.CODIFF_GH_PATH;
    else process.env.CODIFF_GH_PATH = previous;
  }
});
