# Changelog

All notable changes to Infomarchy. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

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
