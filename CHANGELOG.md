# Changelog

All notable changes to Infomarchy. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [1.3.0] — 2026-09-08

### Added
- **Per-model breakdown for every provider.** Anthropic publishes a real rate-limit window per model family, which is where **Fable Weekly** comes from; OpenAI and xAI publish no such window, so the honest equivalent is each model's share of the work. Codex now breaks out `gpt-6-astra` and `codex-auto-review`, Claude shows its models beside their windows, and Grok — which reports no tokens at all — is broken down by sessions per model instead.
- **New models need no code change.** The breakdown is the union of whatever the provider reports in `todayTokensByModel`, `modelUsage` and `modelSessions`, weighted by today's tokens, falling back to lifetime share so a quiet morning still shows the mix, then to sessions where there are no tokens. Not one model name appears in the collector or the view; a test asserts that, ignoring comments.

## [1.2.1] — 2026-09-08

### Fixed
- **Clicking a Herdr card now jumps to that agent's pane.** It focused the Herdr window and left it on whatever workspace was already showing. Herdr draws every workspace inside a *single* window, so an agent's own process ancestry resolves that window directly and the collector's client-window lookup — the only place that set `attached` — never ran. The pane focus was gated on `attached`, so on this box all 19 Herdr sessions reported "not attached" while their panes were perfectly reachable, and the jump never fired. The gate is gone (`focusHerdrPane` already refuses ids it cannot validate), and `attached` now means what it says: the host has a window, however that window was found. The card's own label promised "click jumps to the pane" the whole time.

## [1.2.0] — 2026-09-08

### Added
- **Grok in USAGE & LIMITS.** Omarchy ships no usage collector for Grok, and Grok itself bills credits rather than rate-limit windows — `/usage` opens billing in a browser and nothing about it is cached on disk. What *is* on disk is one directory per session, so the card now reports what is genuinely measurable: prompts today and lifetime, sessions today and lifetime, and the model in use. It draws **no limit bars**, because there are none to draw.

### Changed
- **A provider with no token data no longer reports `0 tok`.** That read as "used no tokens today" when the truth is "publishes no token counts". Providers that do publish are unchanged; `hasTokenData` distinguishes the two.
- **`usageStatusText` is finally rendered.** It had been collected and normalized for months and shown nowhere. It appears under a provider that has no limit bars, so the card can say why — Grok explains its credits, and Fireworks now shows "Fireworks unavailable" instead of a bare zero.

## [1.1.3] — 2026-09-07

### Fixed
- **The version on the desk tracks the manifest.** `omarchy plugin update` rewrites `manifest.json` under a running shell, and the About panel read it once at load — so after an in-place update the desk went on reporting the version it started with, which is the one number that must never be stale. The manifest is watched now.

## [1.1.2] — 2026-09-07

### Changed
- **A video wallpaper is whatever Omarchy says it is.** Both surfaces asked a literal extension list of their own, so a format added to Omarchy's `Util.isVideoPath` would have left the desk blank here until Infomarchy was changed to match. They now defer to `Util.isVideoPath` when the running Omarchy has it, and fall back to the list only where it does not — calling a function that is not there would take the plugin down on exactly the older desktops the fallback exists for.

## [1.1.1] — 2026-09-07

### Fixed
- **Video wallpapers show.** Infomarchy hosts the background layer in place of `omarchy.background`, and drew the wallpaper with a plain `Image`. Omarchy's video wallpapers (quattro) therefore arrived as `Error decoding: ... Unsupported image format` and left the desk on the flat theme colour — selecting one looked like the picker had done nothing. Stills and videos are now handed to separate surfaces, and a video goes to Omarchy's own `BackgroundMedia`, reached through a Loader by URL so an Omarchy without video support never resolves the type and keeps the still path exactly as it was. Playback stops while a fullscreen window covers that output, since Qt's FFmpeg engine drives its own clock and an unseen wallpaper otherwise decodes on. The SUPER+D overlay had the same blank and is fixed with it, and decodes only while it is open.

## [1.1.0] — 2026-09-07

### Added
- Optional read-only **REMOTE** roster from `INFOMARCHY_REMOTE_ROSTER`: bounded local JSON ingest, freshness labels, status counts and compact attention rows beside LOCAL AI. Existing right-column orders migrate automatically; local sessions and notifications stay independent.
- **GITHUB · LAST 7 DAYS.** The activity row is now two half-width cards: the AI prompt heatmap on the left and, on the right, the same hour-by-hour grid fed from GitHub — commits, PRs, reviews, issues, comments and other events, coloured by dominant kind, hover for the breakdown and the repositories, today/week counts in the header. Click pins a cell; a legend kind recolours the grid to that kind alone. It is a removable module (**4** in the overlay; the modules after it shift one key and **0** reaches the tenth) and either card takes the full row when the other is hidden.
- **ABOUT.** The version sits at the quiet end of the legend line under the last card — on screen always, never in the way of the data. Clicking it opens ABOUT: the version, a link to the repository, and a link to nixfred.com. The version is read from `manifest.json` at load, so it cannot drift from the version the plugin actually ships as, and `openUrl` refuses any address other than those two. Esc closes ABOUT before it closes the desk.
- **Grok Bot gets a card per bot.** The xAI desktop app runs its whole roster inside one Electron process, so `/proc` can only ever show one agent. Infomarchy reads the app's own local roster (`~/.config/Grok Bot/sand-client-persistence`, one plain-JSON file per state slice, named by the base32 of its key) and expands it into one **Live AI session** card per bot: the bot's name, the last line it wrote (markdown flattened, secrets redacted the same way prompts are), and its **Needs You** state — *waiting for your answer*, or *has replies you have not read* with the count on the card. Hidden-from-sidebar bots get no card, and transcripts are never opened. Because the bots share one process, its CPU/RAM/GPU counters are attributed once — to the bot the app currently has open — and the other cards report `—` rather than repeating the same process nine times. The alert key omits the unread count, so a bot notifies when it goes unread, not again on every further reply.
- **Grok Bot is detected at all.** Electron rewrites its process title, so the whole command line arrives as a single `argv[0]` — and the install path itself contains a space. The browser process is now matched on that line, while the zygote/renderer/gpu/utility helpers (`--type=`) and the `local-exec-daemon` script are not.
- **Grok CLI sessions are counted from disk.** Grok ≥ 1.0 gives every session its own directory under the encoded cwd, so sessions that have not been prompted yet were invisible. `GROK_HOME` is honoured, and a project path too long to encode is read back from the group's `.cwd` file instead of showing as a slug plus a hash.
- `github-activity.ts`: commits from `gh api search/commits` by author date (one row per commit, default branches only), everything else from the user's own events feed; both slimmed by `gh --jq` so no commit message or issue body is ever parsed. A private `github-activity.json` store, written by the wallpaper collector and read by the overlay, fills the week incrementally (one step a minute until covered, then every five minutes, at most a handful of calls per step), pages the events feed until a known id, walks one search query page by page so timestamp ties cannot stall it, re-walks the window every six hours for late-indexed commits, backs off on failures, resets on an account change, and survives restarts and dropped connections as a *stale* grid. `INFOMARCHY_SKIP_GITHUB=1` disables it.

### Changed
- A live Grok card now resolves its own session id from the session files the CLI holds open, instead of inferring one from the project's prompt history.
- Session cards and the inspector print `—` for a resource counter that is genuinely unavailable, rather than `0B` / `0 proc`.
- The heatmap canvas, tooltip and legend are one `HeatPanel` component used by both cards. Card header hints now elide instead of pushing past a half-width card.

## [1.0.0] — 2026-09-05

1.0 marks the desk as complete for daily use: every card reaches its session (terminal, Herdr, tmux, Boomux or a Claude background job), the whole desk fits a 1920×1080 screen with nothing clipped or running off the edge, and the layout is instrumented so future fixes are measured rather than guessed.

### Added
- **Every Claude card reaches its session.** Claude Code's own registry (`claude agents --json`) is merged by pid: exact job ids on Herdr-hosted sessions, session names on cards, busy state from the registry, `blocked` shown as waiting. Background sessions open with `claude attach <id>` in a terminal. The `claude daemon run` supervisor is no longer mistaken for a session (the phantom "Improving Pi" card).
- **Zombie sessions.** A session that is unattended (background, or no window and nothing attachable), not busy and idle for six hours gets a **STALE · idle Nh** tag. The inspector offers **STOP SESSION** (`claude stop <id>`, transcript kept) and **END PROCESS** (SIGTERM, only if the pid's start time and agent argv still match the card). Two clicks, four-second arm window, never automatic.
- **SUPER+I / SUPER+D legend.** Header hints in the overlay; one quiet line under the MACHINE card on the wallpaper.
- `omarchy-shell infomarchy geometry` — the settled layout widths (view, columns, LOCAL AI card/body/rows/tag/meter and each row's implicit width) as JSON. Read it before touching a layout constant.

### Changed
- **The desk fits 1080p end to end.** MACHINE is a two-column grid (CPU|RAM, DISK|WIFI) with a one-line footer (WAN · LAN / rates · ping · BAT); sessions sit on one row; ops cards are content-sized; RECENT TASKS keeps a minimum height; LOCAL AI rows share one action column with fixed arrow and action slots; Meter values elide instead of pushing; both columns are fractions of the view width, never constants.

### Fixed
- **SUPER+D shows the real desktop** (theme background behind the wallpaper) and **SUPER+I applies inside the overlay** as well as on the wallpaper. SUPER+D then SUPER+I now does what it says.
- **LOCAL AI pills lost their right border.** The provider-chips row was a `RowLayout` of rigid tags whose minimum (514 px) exceeded the card body (512 px); the column then laid every row out 2 px past the clip, cutting the right edge of LOAD/UNLOAD and the GPU bar. The chips are now a `Flow` (no minimum; wraps if labels grow). Found by measuring, not guessing: new `omarchy-shell infomarchy geometry` IPC reports the settled layout widths.

## [0.5.0] — 2026-09-05

### Added
- **7-day token trend** in USAGE & LIMITS: one line per provider, tokens per day, hover for exact figures, with a **TOKENS / ≈ $ VALUE** toggle. Per-provider rows show today's and lifetime *estimated API value*, cache-read share and session count. Fed entirely from Omarchy's Agents usage cache — no new scanning. Prices from a pinned, attributed LiteLLM snapshot (`pricing.json`, `THIRD_PARTY_NOTICES.md`); unknown models are shown as unpriced, never guessed.
- **Clicking a card jumps inside the multiplexer.** Herdr: the agent descends from `herdr server`, so the client terminal is found through the Herdr client process and the pane is focused over Herdr's socket API (`workspace.focus → tab.focus → pane.focus`, bundled `herdr-focus.ts`). tmux: `select-window`, `select-pane`, `switch-client`. Boomux: window matched via the `__attach` client or Boomux's own window title, then `boomux open <shell-id> --workspace <name>` (verified on 1.9.7).
- Sessions running under Claude Code's background daemon (`bg-pty-host`) are labelled **background · claude daemon** and dimmed instead of looking like a duplicate of the interactive session in the same repository.

### Fixed
- Attention rows and the inspector's FOCUS use the multiplexer-aware path.

## [0.4.1] — 2026-09-05

Marketplace security-review follow-up (omacom/omarchy-plugin-marketplace#2931).

### Changed
- Subprocess deadlines are firm: SIGTERM, a 250 ms grace period, SIGKILL if still alive, then reaped — in the collector and in every window-preview stage.
- Successful preview artifacts are deleted with an ownership check when a preview is replaced, when previews are disabled, when the session's window is gone, and when the view is destroyed; the stale sweep is capped at 32 removals per run.

## [0.4.0] — 2026-09-05

First marketplace release with the operations desk. Verified on a stock Omarchy 4.0.2 VM (fresh install, no bun → install hint → `pacman -S bun` → desk fills in without a restart), and by two independent Codex reviews (gpt-5.6-sol and gpt-6-astra) whose 60+ confirmed findings were each reproduced before being fixed.

### Added
- **Operations desk**: WHAT CHANGED (per-repository working-tree summary with seen/unseen tracking), NEXT ACTIONS (specific blocked / waiting / review signals with one-click ANSWER / RESOLVE / REVIEW / RESUME), PROJECT HEALTH (branch, dirty state, ahead/behind, last commit, newest GitHub Actions run via authenticated `gh`, click to filter the whole dashboard). All three are draggable and individually removable.
- **Proactive alerts** through Omarchy's notification service: blocked, waiting, ready-for-review, ended, and title-reported crashes; persistent seven-day deduplication with episode tracking; global switch, per-provider mutes, and quiet hours (22:00–08:00). Clicking an alert opens the fullscreen desk.
- **Multiplexer-hosted sessions**: agents inside Herdr, Boomux, or tmux stay visible with their bounded host identity; an attached tmux pane focuses its real client terminal and switches the client to that pane.
- **Ollama controls**: pick any installed model, LOAD (pinned) / UNLOAD per loaded row, size-aware CONFIRM for large models.
- **Hermes** (NousResearch) detected as a provider.
- Session inspector (right-click a card): move to workspace, focus, open a terminal in the project, toggle hover previews.
- Prompt search, pinning, and per-cell heatmap drill-down; recent rows shipped up to 1,000 for a full week.
- `CHANGELOG.md`, and a `bun` install step in the README (Omarchy does not ship bun).

### Changed
- Collector output is one awaited write; snapshots are capped at 960 KiB, below the shell-side limit, so a valid frame can never be rejected.
- Every external JSON source (histories, usage caches, Ollama, hyprctl, gh) is parsed through one bounded, coercion-safe path; malformed or hostile content degrades a single card, never the desk.
- Automatic topic refinement talks only to a loopback Ollama unless `INFOMARCHY_ALLOW_REMOTE_OLLAMA=1` is set — prompt text does not leave the machine by default.
- Demo mode now covers the SUPER+D overlay as well as the wallpaper.
- Credential redaction covers env-style assignments, credentials in URLs, PEM blocks, JWTs, and common cloud key shapes (best effort).
- Provider detection matches the executable only (or a script run by a known interpreter): `cat /tmp/claude` is no longer an agent.
- Attention signals are evaluated only for idle agents; a title that mentions "permission" or "failed" mid-task no longer alerts.
- The collector keeps running at a quarter cadence while the desk is hidden so alerts still arrive; it stops entirely only when alerts are off too.
- Throughput is displayed in bits/s; COPY PROMPT is now COPY EXCERPT (140-character redacted excerpt).

### Fixed
- Desk went blank on: a `%` in a Grok session directory name, a non-array `active_sessions.json`, a nested object in a Grok pid, a null entry from `hyprctl clients`, `{"toString":0}` anywhere in external JSON, two large usage caches, and a `history.jsonl` over 8 MB (Claude then showed as "not installed"). All degrade gracefully now.
- Desk froze when a killed helper left a child holding its pipe (`gh` → `git`, shell → `sleep`); the collector now abandons the pipe at its deadline and exits explicitly.
- Ollama LOAD / UNLOAD never completed (helper waited for stdin EOF that Quickshell never sends).
- Topic refinement cached its own timeouts as summaries and never retried; Codex rows had no project and RESUME opened `$HOME`; pinned prompts vanished past 80 rows; quiet-hours and muted alerts were marked delivered and never shown; the first snapshot after a restart dropped ended-session events.
- Display escaping corrupted paths and clipboard text (`~/R&D` → `~/R＆D`); `/home/pi2` was treated as inside `/home/pi`; Git paths with non-ASCII characters were shown as octal escapes.
- Session inference could bind a live agent to a later session's prompts or steal an id another live agent owned.
- Resource leaks: preview temp directories, orphaned state temp files, unbounded topic/pin/mute/seen maps, per-tick full scans of `opencode.db`, unbounded git/gh/Ollama fan-out, rollout enumeration past the cap.
- Inspector drawer froze on stale data; the wallpaper search box could never receive keystrokes; busy/attention animations ran while hidden; garbage `nvidia-smi` / `df` / `ping` output rendered as an empty GPU, a null disk, or a QML binding error.

## [0.2.1] — 2026-08-28

- Four live session cards per row; clipboard and preview helper hardening.

## [0.2.0] — 2026-08-27

- First marketplace-hardened build: live AI sessions, 7-day heatmap, recent tasks, usage limits, local AI, machine telemetry, SUPER+D overlay, SUPER+I toggle.
