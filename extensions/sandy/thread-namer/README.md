# sandy-plugin-thread-namer

Names [sandy](https://getbb.app) threads with an agent, so the sidebar reads like a
list of what you were doing instead of a list of first lines.

- **Automatic.** When a thread's first turn finishes, the plugin reads the
  opening of the conversation and writes a short title onto the thread.
- **On demand.** A button in the thread header re-generates the name of the
  thread you are looking at. `sandy thread-namer rename` does the same from a
  terminal or from an agent.
- **Your model.** By default the naming turn runs on the same model and harness
  as the thread it is naming. Pick one model for every thread instead in
  **Settings → Plugins → Thread Namer**, from a searchable catalogue of every
  model your signed-in agents report, with that model's reasoning efforts.

A title you typed yourself is never overwritten by automatic naming.

## Install

```sh
sandy plugin install https://github.com/suiramdev/sandy-plugin-thread-namer
```

Or from a checkout:

```sh
git clone https://github.com/suiramdev/sandy-plugin-thread-namer
cd sandy-plugin-thread-namer
npm install
sandy plugin install .
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Automatic naming | Name a thread once, after its first reply | `once` names an untitled thread when its first turn ends. **Keep the name up to date** re-names it after every later turn, as long as the current name is still one this plugin wrote. **Never** leaves naming to the header button and the CLI. |
| Name length | Medium — up to 48 characters | The budget the agent is given, and the length a longer answer is cut to. |
| Naming instruction | see below | The instruction sent with the conversation. Clear it to restore the built-in one. |
| Timeout | 1 minute | How long to wait for the naming agent before giving up. |
| Naming agent | The thread's own agent | Which agent writes names — the default reuses the thread's own model, reasoning level and harness. |

Settings are edited in the app, or with `sandy plugin config thread-namer set …`.

## Which threads get named

Automatic naming skips:

- threads with a name you typed (a name this plugin wrote is fair game),
- hidden threads, including this plugin's own naming worker,
- child threads — subagent and background threads are named by their parent,
- archived and deleted threads.

The header button and `sandy thread-namer rename` ignore the "Automatic naming"
setting and re-name a thread you already named by hand, but they still refuse
hidden and child threads.

## CLI

```sh
sandy thread-namer rename [<threadId>]   # defaults to the calling thread
sandy thread-namer status                # how naming is configured
```

## How a name is made

The plugin never types into the thread it is naming. It spawns a hidden,
throwaway thread that reuses the named thread's environment (so no worktree is
created), runs one prompt on the least privileged permission mode the agent
supports — naming needs no tools — then stops and deletes that worker on every
path, including failures.

The prompt is the conversation outline: the first few turns, each truncated,
with the built-in instruction:

> Write a short title for the conversation below, the way a person would name a
> tab they want to find again later.

The answer is unwrapped (fences, quotes, a `Title:` prefix, a line of preamble)
and cut to the length budget on a word boundary. An empty answer is reported,
never written.

## Where the re-generate control lives

In the **thread header**, not in the sidebar row's context menu. sandy's sidebar
menu is host-rendered and has no contribution point for plugins: the only way
to add a row to it is to replace the whole sidebar thread list
(`experimental_threadList`), which is an exclusive slot — it would conflict with
any other plugin that replaces the sidebar, and would make this plugin
responsible for the entire list. A header button plus the CLI covers the same
intent without taking that over.

## Development

```sh
npm install
npm run typecheck
npm test
sandy plugin dev          # rebuild + reload on every save
```

Tests need **Node 22** (`.nvmrc`): the plugin test harness loads
`better-sqlite3`, which has no prebuilt binary for newer Node releases. The
plugin itself runs inside the sandy server and does not depend on it — a
`sandy plugin install` from git omits dev dependencies entirely.

| File | What it holds |
| --- | --- |
| `server.ts` | Registrations, the naming run, the model catalogue cache |
| `lib/title.ts` | The naming prompt and turning an answer into a title |
| `lib/policy.ts` | Which threads may be named, and when |
| `lib/models.ts` | Catalogue shapes and the picker's search rules |
| `app.tsx` | The header button and the settings section |
| `components/ModelPicker.tsx` | The searchable model + reasoning picker |

## License

MIT
