# Bookmarks

Bookmarks saves chat messages worth coming back to and lists them in a
**Bookmarks** tab in the thread's right panel. Clicking a bookmark opens its
thread scrolled to the message.

```text
Search                          [All | This thread]
─────────────────────────────────────────────────
Fix the flaky upload test · You                2h
Can we retry the upload before failing the job…
Plan the storage migration                     3d
│ Run the backfill before switching reads…
```

## Use

- **Bookmark a message**: hover a user or assistant message and click the
  bookmark button in its action bar. A bookmarked message keeps a filled
  bookmark button; clicking it again removes the bookmark (with Undo).
- **Bookmark a passage**: select text in an assistant message and choose
  **Bookmark** in the selection menu. The selection becomes the bookmark's
  quote; a message still has one bookmark.
- **Open the list**: the bookmark button in the thread header, **Bookmarks**
  in the side panel's new-tab actions (also on the New thread screen), or
  `Bookmarks: Show saved messages` in the quick palette.
- **Jump back**: click a bookmark. When it belongs to another thread, the
  Bookmarks tab follows you there on desktop-width windows.

## How it works

- Bookmarks are stored in the plugin's SQLite database
  (`<sandy data dir>/plugins/bookmarks/data.db`), keyed by thread and the message's
  `sourceSeqEnd`, with a copy of the message text (up to 64,000 characters) and
  a snapshot of the thread title.
- The jump uses the same router state sandy's thread search uses
  (`searchMessageSeq`), so sandy itself pages back to the message, scrolls to it,
  and flashes it. If that state stops working in a future sandy, clicking a
  bookmark still opens its thread.
- Bookmarked messages are marked by a stylesheet keyed on the timeline's
  `data-timeline-row-id` attribute, so the mark follows rows through the
  virtualized timeline without observing the DOM.

## Install

```sh
sandy marketplace add git:https://github.com/rebryk/sandy-plugins.git@main
sandy plugin install bookmarks@sf-plugins
```

Use `sandy plugin install .` from this directory instead when working on it
locally.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
sandy plugin reload bookmarks
```
