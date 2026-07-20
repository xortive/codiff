import type { MergeRequestVersionRef, VersionPatchFile } from '../version-compare.ts';

/** Synthetic fixtures used for version-comparison algorithm coverage without live GitLab. */

export const pureRebaseVersions = {
  from: {
    baseSha: 'base-a',
    createdAt: '2026-06-01T00:00:00.000Z',
    headSha: 'head-a',
    id: '1',
    label: 'v1 · head-a',
    startSha: 'base-a',
  },
  to: {
    baseSha: 'base-b',
    createdAt: '2026-06-02T00:00:00.000Z',
    headSha: 'head-b',
    id: '2',
    label: 'v2 · head-b',
    startSha: 'base-b',
  },
} satisfies { from: MergeRequestVersionRef; to: MergeRequestVersionRef };

const sameLogicalPatch = '@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+newCall();\n';

export const pureRebaseFiles = {
  from: [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: sameLogicalPatch,
      status: 'modified',
    },
  ],
  to: [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      // Context lines shifted after rebase, same change regions.
      patchBody: '@@ -10,2 +10,2 @@\n const value = 1;\n-old();\n+newCall();\n',
      status: 'modified',
    },
  ],
} satisfies {
  from: ReadonlyArray<VersionPatchFile>;
  to: ReadonlyArray<VersionPatchFile>;
};

export const rebasePlusEditFiles = {
  from: pureRebaseFiles.from,
  to: [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: '@@ -10,2 +10,3 @@\n const value = 1;\n-old();\n+newCall();\n+guard();\n',
      status: 'modified',
    },
    {
      newPath: 'README.md',
      oldPath: 'README.md',
      patchBody: '@@ -1 +1 @@\n-hello\n+hello world\n',
      status: 'modified',
    },
  ],
} satisfies {
  from: ReadonlyArray<VersionPatchFile>;
  to: ReadonlyArray<VersionPatchFile>;
};

export const conflictResolutionFiles = {
  from: pureRebaseFiles.from,
  to: [
    {
      newPath: 'src/app.ts',
      oldPath: 'src/app.ts',
      patchBody: '@@ -1,5 +1,7 @@\n<<<<<<< HEAD\n-old();\n=======\n+resolved();\n>>>>>>> feature\n',
      status: 'modified',
    },
  ],
} satisfies {
  from: ReadonlyArray<VersionPatchFile>;
  to: ReadonlyArray<VersionPatchFile>;
};
