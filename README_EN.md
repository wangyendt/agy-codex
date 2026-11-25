# agy-c

[简体中文](README.md) · [MIT License](LICENSE)

Antigravity handles planning, design, and writing; Codex handles implementation, debugging, tests, and review. `agy-c` installs the routing rules and gives each workspace a repeatable Codex handoff. Image generation and editing route to `codex-task image` when available. No startup hooks or background services are installed.

## Quick start

Use Node.js 20 or later on macOS, Ubuntu/Linux, or Windows (PowerShell or CMD). The commands are the same on all three platforms:

```sh
npm install -g agy-c
agy-c setup
agy-c doctor
```

Before the first npm release, clone this repository and run `npm ci`, `npm run build`, and `npm install -g .` from the clone instead. On Windows, use `npm.cmd` and `agy-c.cmd` if PowerShell blocks the corresponding `.ps1` shims.

`setup` offers to install missing `@openai/codex` and `codex-task` in an interactive terminal. Use `--yes` or `--install-deps` to opt in without prompting, or `--no-install-deps` to configure files only. Non-interactive sessions without opt-in get an install command, not a silent install. Sign in with `codex login` if needed; `doctor` reports the local auth file and known token expiry, not whether the server still accepts the token.

## Delegate a task

Put your plan, pointers, and checks in a short UTF-8 handoff brief. Keep state and reports outside the worktree if you do not want Git to track them.

```sh
agy-c run --cwd . --brief handoff.md --thread-state threads.json -o result.md --json
agy-c run --cwd . --thread-state threads.json "Rerun only the failing test"
agy-c run --cwd . --review --uncommitted
```

The first successful run saves the thread ID under the resolved workspace path. The second resumes it. Use `--new` for unrelated work, `--resume ID` to name a thread, or `--fork ID` to branch it. A review can target `--uncommitted`, `--base BRANCH`, or `--commit SHA`; omit these to give custom review instructions. Reviews and failed runs don't overwrite the saved conversation.

A prompt may come from an argument, `--brief`, or piped stdin; supplied inputs are combined in brief → argument → stdin order. `--events-log FILE` saves the raw event stream; it can contain sensitive task content. `--json` emits a compact result with status, thread ID, Codex binary/version, exit code, output path, and final text. Relative artifact paths are resolved from the caller's directory. The default sandbox is `workspace-write`; use `--sandbox read-only` for inspection-only tasks.

## Manage configuration and updates

| Command | What it does |
| --- | --- |
| `agy-c setup --dry-run --json` | Preview the managed file changes and any dependency installation command. |
| `agy-c doctor --offline --json` | Check local CLI, Desktop, SDK, auth, rules, and proxy status without contacting npm. |
| `agy-c upgrade --only codex,codex-task --dry-run` | Check npm versions and preview updates. Omit `--dry-run` to apply; use `--yes` to approve npm installs. Desktop and the bundled SDK are reported separately. |
| `agy-c uninstall --sync-gemini-cli` | Remove managed routing, including its optional Gemini CLI mirror. Does not uninstall npm packages or delete user-authored rules. |

The managed files are `~/.gemini/config/AGENTS.md` and `~/.gemini/config/rules/codex-delegation-protocol.md`. Keep custom text outside the `agy-c` marker pair. Setup replaces the known, unchanged legacy policy without duplication and leaves unrecognized manual rules alone with a warning. Use `--sync-gemini-cli` to mirror the routing block to `~/.gemini/GEMINI.md`. If available, the packaged CodexTask skill is copied when it differs; pass `--no-sync-skill` to preserve a customized copy. Use `--no-rules` or `--no-restart-service` to skip those upgrade steps. A service is restarted only after a successful `codex-task` upgrade.

Run `agy-c <command> --help` for all options, including custom home, npm registry/prefix, model, and binary overrides.

## Development and releases

```sh
npm ci
npm run verify
```

CI runs lint, typecheck, tests, build, package inspection, and installed-tarball smoke tests on all three operating systems. The publisher is disabled until the repository variable `AUTO_PUBLISH_NPM=true` is set. For a new npm package, an authorized maintainer must bootstrap the package first; then [configure npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) for GitHub owner `wangyendt`, repository `agy-c`, workflow `publish-npm.yml`, with permission to publish and no environment name. Once enabled, dispatch **Publish npm** on `main` for an unpublished version, or dispatch **Bump patch on main** if the current version already exists. The bump workflow needs permission to push to `main`; if branch protection prevents that, bump via PR and dispatch **Publish npm** manually after merge. No npm token or GitHub PAT is required for the OIDC workflow.
