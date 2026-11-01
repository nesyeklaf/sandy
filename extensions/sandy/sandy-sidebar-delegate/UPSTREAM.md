# Upstream

This directory is a fork of **sandy-sidebar**.

| | |
|---|---|
| Source | https://github.com/yusuf8834/bb-sidebar |
| Version | 0.3.7 (tag `v0.3.7`) |
| Commit | `e4b58830658cf738a11ea1d51652d2887131df14` |
| License | MIT, Copyright (c) 2026 Michael Yong and Yusuf Akbulut (see `LICENSE`, `THIRD_PARTY_NOTICES.md`) |
| Imported from | the installed copy in SANDY's plugin cache (`plugins/cache/git/github.com/yusuf8834/bb-sidebar/e4b58830…`) |

The import is the upstream tree unchanged, minus `node_modules/`, `dist/` and `.github/`.
Fork changes sit on top of it. Everything not listed below is upstream.

## Plugin id

`package.json` name is `sandy-plugin-sandy-sidebar-delegate`, so the plugin id is `sandy-sidebar-delegate`
(SANDY drops the `sandy-plugin-` prefix). It installs next to the original `sandy-sidebar`. The two keep
separate server storage (settings, lifecycle, inbox order), so settings are entered once in the fork.
Browser-side preferences use the same `sandy-sidebar:*` localStorage keys and carry over. Run only one of
the two sidebars at a time.

## Fork changes

- `src/delegate-children.ts`: pure grouping rules (`mergeDelegateChildren`) and the mapping from sandy's thread
  list entry to a sidebar row.
- `src/server-delegate-children.ts`: RPC `listDelegateChildren` (`sandy.sdk.threads.list` per origin plugin with
  `includeHidden: true, archived: false`) and the `delegate-children` realtime channel, published when a
  delegate or workflows-plus thread changes.
- `src/useDelegateChildren.ts`: fetches the list, refreshes on the channel and every 20 s.
- `src/sandy-sdk.ts`: `useSidebarThreads` now returns the host threads merged with those children and
  `delegateChildrenLoaded`.
- `src/ThreadInbox.tsx`: the child-expansion prune waits for `delegateChildrenLoaded`.
- `src/inbox.ts`: `visibleInboxThreads` also drops hidden threads, so a hidden thread is never a root row.
- `src/contract.ts`, `src/realtime-channels.ts`, `src/server-handlers.ts`, `src/server.ts`: the new RPC and channel.
- `package.json`: name, version (`0.3.7-delegate.1`), description, `UPSTREAM.md` in `files`; the
  `prepare: lefthook install` script, the `lefthook` devDependency and `lefthook.yml` are removed (they would
  install git hooks into the monorepo's `.git`).
- In review shelf: `src/in-review.ts` (an open, non-draft PR on the thread's environment puts an Active or
  Working thread here; the PR comes from the GitHub PR Status plugin), `src/useOrderedShelf.ts` (shelf ordering and
  attention helpers moved out of `ThreadInbox.tsx`), `review` in `ShelfExpansionState` and its codec,
  `useThreadPullRequestsByEnvironment` in `src/sandy-sdk.ts`, and the first shelf (upstream "Active") is labelled "Needs you" in its header and move announcements; the code still calls it `active`.
  Tests: `src/in-review.test.ts`, `src/ThreadInbox.review-shelf.test.tsx`.
- Tests: `src/delegate-children.test.ts`, `src/server-delegate-children.test.ts`,
  `src/ThreadInbox.delegate-children.test.tsx`; `src/test-inbox.tsx` (`render` takes extra RPC handlers and
  answers `listDelegateChildren` by default) and `src/test-fixtures.ts` (`delegateChildRecord`).

## Grouping rules

1. Only threads whose `originPluginId` is `delegate` or `workflows-plus` are considered.
2. Archived children are dropped.
3. A child hangs under `parentThreadId`, else `lifecycleOwnerThreadId` (workflows-plus workers have only
   the latter). One with neither is dropped.
4. The parent chain must reach a thread the host lists and has not archived; a missing, archived or cyclic
   chain drops the child. A worker under a delegate child is nested two levels deep.
5. A thread the host already lists keeps the host's row; if that row has no parent, the child's parent is set.
6. The rest are appended as hidden rows under their parent. Upstream's child list then shows them collapsed
   behind the parent's count; a child waiting on the user (`hasPendingInteraction`) also shows while
   collapsed and makes the parent's badge "needs you". Expand/collapse per parent is upstream's persisted
   `child-expansion` preference.

## Running the tests

```
npm ci --ignore-scripts && (cd node_modules/better-sqlite3 && npx prebuild-install)
NODE_OPTIONS=--no-experimental-webstorage timeout 180 npx vitest run --config vitest.config.ts --reporter=verbose --testTimeout=20000
npx vitest run --config vitest.config.ts src/delegate-children.test.ts src/server-delegate-children.test.ts   # seconds
```

On Node 25+ the global `localStorage` is undefined without `--localstorage-file`, so upstream's jsdom
tests (`src/test-app-setup.ts` calls `localStorage.clear()`) fail or time out and a plain full run hangs for
minutes. This is upstream behavior on Node 26, not part of the fork. With
`--no-experimental-webstorage` the whole suite runs in under a minute.
