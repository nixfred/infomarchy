# Development apps

The optional **APPS** module puts local development services on the desk. Enable
it in the module strip, then use **Add App** to save a checkout, its existing
command, a fixed port and an optional HTTP health path. Registration neither
starts the app nor enables login startup. No application files are changed.

Use **Open**, **Start/Stop**, **Restart** and **Logs** on each card. The card shows
HTTP readiness, the served checkout, Git branch and changed-file count. Privacy
and demo modes hide app details/logs and disable actions. Hiding the desk or
closing an agent task does not stop a service.

## Requirements and setup

Uses the plugin's existing Bun runtime (tested with Bun 1.4), systemd **user**
services, Git, `ss` from iproute2 and `flock` from util-linux. There is no package
install, Python dependency or extra daemon. Each app still needs its own runtime,
dependencies and local configuration.

The desk invokes the bundled helper directly. To install the optional terminal
command, run from the installed plugin:

```bash
bun ~/.config/omarchy/plugins/nixfred.infomarchy/app-services.ts setup
~/.local/bin/infomarchy-apps status
```

Setup creates the CLI symlink and refreshes registered unit definitions. It
preserves running processes and existing login startup settings. Re-run it after
moving the installed plugin, before starting services from that new location.
Unrelated unit files and existing command files are never replaced.

## Register and control an app

```bash
infomarchy-apps register --registration '{"id":"my-app","name":"My App","path":"~/Work/my-app","port":4400,"command":["npm","run","dev","--","--port","4400"]}'
infomarchy-apps ensure my-app --json
infomarchy-apps status my-app
infomarchy-apps logs my-app
infomarchy-apps restart my-app
infomarchy-apps stop my-app
infomarchy-apps autostart my-app on   # optional login startup; use off to disable
```

The app must honor its assigned port and refuse fallback ports (for example,
Vite's `strictPort`). Registration does not rewrite `npm run dev` or add a wrapper
to the repo. Commands are argument arrays; the Add App command field accepts
quoted arguments, without shell expansion, pipes or redirects. Use an explicit
`env KEY=value command` for environment overrides. Services do not source your
interactive shell; provide a full executable path or a runtime wrapper such as
`mise exec -- npm run dev` when needed. `PORT` and `NODE_ENV=development` are set.

App IDs, folders and ports must be unique. The registry is
`$XDG_CONFIG_HOME/infomarchy/apps.json` (default `~/.config/infomarchy/apps.json`).
Logs are `$XDG_STATE_HOME/infomarchy/apps/logs` (default `~/.local/state/...`).
`INFOMARCHY_APPS_REGISTRY` selects an existing alternative registry, useful for
isolated verification. New default installations start with an empty registry.
After manual registry edits, use `infomarchy-apps install` to refresh the units.

## Sharing a service between agents

Any agent or terminal can use the same CLI. `ensure` starts the registered unit
if needed, waits for HTTP readiness, and reuses it on later calls. Concurrent
lifecycle operations are serialized per app using OS file locks. The service
manager starts and stops the unit's complete process group; failed app processes
restart with bounded retries. No helper remains resident alongside the app.

Suggested instructions for an agent:

> Before browser verification, inspect `infomarchy-apps registry --json`. For a
> matching checkout, run `infomarchy-apps ensure <id> --json` and check readiness.
> Use status and logs to diagnose failures. Do not launch duplicates, kill an
> unrelated listener, silently change ports, or stop shared services when done.
> Use stop/restart only when that app is the intended target.

An app's URL serves its recorded checkout. `ensure` refuses to silently use it
from another worktree of the same repo. Register that worktree separately with a
distinct ID and port. `--shared` explicitly selects the original checkout; it
cannot verify another worktree's edits. Agent-specific hooks are not required,
and setup does not modify any agent configuration.

## Readiness and limits

Ready means the assigned port has a listener inside the service's cgroup and
an HTTP check returns 200–499. Redirects are not followed. A failing HTTP check
is shown separately from a stopped process. An external listener is reported
with its PID/directory and is never killed or adopted. Failed socket inspection
is an error, not evidence that the port is free.

Stopped ports are not reserved against programs launched outside this manager.
It does not intercept arbitrary terminal or agent commands or repair app bugs,
missing credentials or dependencies. Containers and remote services are outside
this module's scope. Application logs are appended without removing successful
HTTP request lines; **Clear View** only clears the displayed snapshot. Systemd
lifecycle details are also available through `journalctl --user -u <unit>`.

## Remove

Before removing the plugin, stop each registered app and disable any login
startup you enabled. Remove only its corresponding managed user unit, then run
`systemctl --user daemon-reload`. Remove the `~/.local/bin/infomarchy-apps`
symlink. Keep the registry/logs if you want to restore them later. There is no
agent configuration to undo. Removing a registration currently means stopping
its unit, removing that unit and removing its row from the registry.

## Validation

`bun test` includes isolated manager, locking, HTTP and Git-worktree tests. Unit
operations in the normal suite are mocked; it never starts or stops your apps.
Run `bun app-services.live.ts --run` for the opt-in systemd smoke test. It uses
an isolated registry and a temporary app, checks real ownership and concurrency,
and removes its own unit and logs on completion. Existing registrations stay
unchanged.
