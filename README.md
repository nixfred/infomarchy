<h1 align="center">Infomarchy</h1>

<p align="center">
  <b>Your wallpaper, promoted to information desk.</b><br>
  Every AI agent running on your machine, what it's doing, what it cost you, and how the box is holding up —<br>
  drawn live on the Omarchy desktop in your current theme, one glance away, one click to jump in.
</p>

<p align="center">
  <a href="https://omarchy.org"><img alt="Omarchy plugin" src="https://img.shields.io/badge/Omarchy-plugin-00c6c2?style=flat-square"></a>
  <img alt="Quickshell" src="https://img.shields.io/badge/Quickshell-QML-5c7cfa?style=flat-square">
  <img alt="bun" src="https://img.shields.io/badge/collector-bun%20%2B%20TypeScript-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="Hyprland" src="https://img.shields.io/badge/Hyprland-0.5x-58a6ff?style=flat-square">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-58ad73?style=flat-square"></a>
</p>

<p align="center">
  <img src="preview.png" alt="Infomarchy with sanitized demo data on an empty 1080p Omarchy desktop: live AI sessions, 7-day heatmap, recent tasks, usage limits, local AI, and machine stats" width="100%">
</p>

The public preview is the real plugin rendered on an empty Omarchy desktop using Infomarchy's explicit, transient demo-data mode. It contains no live prompt, hostname, username, network, path, process, or session data.

> **Want to see the plain desktop?** Press **`SUPER + I`** to hide the Infomarchy cards and reveal your wallpaper. Press **`SUPER + I`** again to bring the dashboard back. Add the one-time key binding shown under [Install](#install).

---

## Why

You run Claude Code in three terminals, Codex in a fourth, Grok is poking at a repo somewhere, Ollama is warming a model, and your weekly limit is quietly at 86%. The only way to know any of that is to go *look* — tab through windows, read titles, run `nvidia-smi`, open a dashboard.

Infomarchy puts all of it on the one surface you always have open and never use: **the wallpaper.** It's not a widget in the bar and not another window to manage. It's the desk itself, and it's always current.

## What you get

<table>
<tr>
<td width="62%" valign="top">

### 🟡 Live AI sessions — *who is working right now*

<img src="docs/sessions.png" alt="Live AI sessions card">

One card per running agent — **Claude Code, Codex, Grok, Gemini, opencode, aider, Ollama chats** — detected straight from `/proc`, no agent-side hooks, nothing to configure. Each card shows the project, working directory, how long it's been up, the pid, the workspace it lives on, and the terminal's own title. Its two-line **current topic** is a short synopsis derived from several exact-session requests—not the last prompt copied onto the card. A loaded local Ollama model may refine the wording; summaries are cached by session/content and Infomarchy never auto-loads a model. The dot **pulses while the agent is thinking**.

Each card also attributes live CPU, resident RAM, process-tree size, and—when `nvidia-smi` exposes compute PIDs—GPU memory to that agent. The detailed totals repeat in the inspector; unavailable counters display `—`.

Only the full per-session cards appear in Live AI Sessions; there is no duplicate compact workspace-card strip. Each large card includes its workspace number. In the session inspector, workspace buttons 1–10 can move that exact agent window silently; the current workspace is highlighted and disabled.

Window thumbnails are opt-in: right-click a large session card, toggle **PREVIEWS OFF/ON** in its inspector, then hover a live card. Infomarchy captures only that exact address after a short delay, downsizes it to 160×90, applies a heavy blur, and displays a 320×180 still. The raw capture moves through bounded in-memory streams from `grim` to ImageMagick without touching disk; the blurred result is written through an exclusive no-follow descriptor inside a random private temporary directory.

Cards also show the repository branch, clean/changed state, ahead/behind counts, and merge conflicts. A **Needs You** strip calls out agents that appear blocked, waiting for input, or finished for review, plus repositories being shared by multiple live agents.

Active Needs You signals get a faint breathing outline (the module chip glows too if the card is removed). Click the signal to focus it, **10M** to snooze it for ten minutes, or **×** to dismiss that signal for the lifetime of its process. Snoozes and dismissals persist between the wallpaper and fullscreen overlay.

**Click a Needs You signal → jump straight to that agent's terminal.** From the fullscreen overlay, Infomarchy closes itself after focusing the session.

**Click a card → Infomarchy focuses the terminal window hosting that agent.** It walks the process tree up to the Hyprland client, so it works through `kitty`, `alacritty`, `ghostty`, tmux, whatever.

**Right-click a card → inspect it in place.** The centered inspector shows its window, shortened session identity, workspace, uptime, pid, and repository state. From there you can focus the existing window or open a fresh terminal in the project directory; paths are passed as process arguments, never evaluated as shell text.

</td>
<td width="38%" valign="top">

### 🟢 Usage & limits — *what it's costing you*

<img src="docs/usage.png" alt="Usage and limits card">

Session (5-hour) and weekly (7-day) rate-limit meters with time-to-reset, today's prompt count and token volume, per subscription. Meters turn **yellow past 60%** and **red past 85%**, in your theme's yellow and red.

Provider chips filter the card interactively. Toggle **PERCENT / FORECAST** to project each recognized 5-hour or 7-day meter to reset from its elapsed-window pace; young or malformed windows say `learning` instead of showing a misleading number.

Infomarchy reuses the cache that Omarchy's own `omarchy.agents` bar widget maintains — enable that widget once and this card lights up. No extra logins, no API keys.

### 🟢 Local AI

Ollama up/down, every **loaded** model with its VRAM, GPU utilisation / memory / temperature, and lifetime totals per provider.

</td>
</tr>
</table>

### 🟡 Activity · last 7 days — *when you actually work*

<img src="docs/heatmap.png" alt="7-day hourly activity heatmap">

An hour-by-hour heatmap of prompts across **every** provider, newest day at the bottom, with a red tick at *now*. The dominant provider colours each cell; intensity is volume. Hover a cell for the exact breakdown (*"Tue 18 Aug 16:00 · 8 prompts (Claude 6, Codex 2)"*). Click an hour to filter Recent Tasks to that hour; click a provider in the legend to combine a provider filter. The selected cell and provider stay outlined, and clicking either again—or **clear**—removes that part of the filter. The header carries today/week counts per provider.

### ⚪ Recent tasks — *what got asked*

The newest prompts across all providers — time ago, provider tag, project, and the prompt itself — so the question *"what was I doing an hour ago?"* has an answer on the wall. The list keeps up to 80 rows in a scrollable history, with a search box that matches prompt text, project, or provider (filtered searches can show up to 200 matches). Prompts whose exact agent session is still running stay bright and clickable; click one to jump to its terminal. Supported closed sessions are dimmed but remain interactive: hover for **RESUME**, then click to reopen that exact Claude, Codex, Grok, or OpenCode session in a terminal at its project directory.

Right-click a prompt for its action drawer: copy, pin/unpin, open the project, and review up to five recent prompts from the same session. Pins persist and sort above ordinary recency without changing the underlying history. Wheel and touchpad deltas are handled directly by the row beneath the pointer, and the wider scrollbar track can be clicked or dragged.

### 🟢🟡🔵 Machine — *the boring numbers, in the corner where they belong*

<img src="docs/machine.png" alt="Machine stats card">

| Meter | Colour | Detail |
|---|---|---|
| **CPU** | theme blue | % busy, 1-min load, hottest thermal zone |
| **RAM** | theme **green** | used / total, % |
| **Disk** | theme **yellow** | used / total per mount (btrfs subvolume twins collapsed) |
| **Wi-Fi** | theme **green** | SSID, signal in dBm (bar = link quality), IPv4 |
| **WAN** | theme cyan | cached external IPv4/IPv6 |
| **↓ ↑ throughput** | green | **real-time** bytes/s on the default route interface, wired or wireless |
| **⇄ latency** | green / yellow / red | live **ping to Cloudflare 1.1.1.1** — red on timeout |
| **Battery** | — | % and charging state, hidden on desktops |

Any meter goes **red** when it's genuinely in trouble (RAM > 90%, disk > 90%, CPU > 85%, ping dead).

The three right-column cards—Usage, Local AI, and Machine—have draggable headers. Drag one far enough up or down to swap it with its neighbor; the card snaps into place and the order persists across overlay and shell restarts. Every section can still be removed and restored from the module strip.

### ⌨️ Two surfaces, one dashboard

The wallpaper is interactive wherever no window covers it (double-click or right-click the empty desk opens Omarchy's wallpaper switcher, as stock does). Press **`SUPER + I`** to hide the wallpaper dashboard and see the clean desktop; press it again to restore the cards. When you're buried in terminals, **`SUPER + D`** summons the *same* dashboard as a fullscreen overlay on top of everything; `Esc` or a click on the backdrop dismisses it.

The module strip doubles as a keyboard command strip in the overlay: **1–7** toggle modules, **J/K** (or arrows) select a live session, **Enter** focuses it, **A** clears activity filters, and **Esc** closes. The selected session gets a bright outline.

## Install

```bash
omarchy plugin add https://github.com/nixfred/infomarchy.git --enable --yes
omarchy restart shell    # first time only: services load at shell start
```

The plugin declares itself as a clone of `omarchy.background`, so Omarchy hands it the wallpaper role. Your chosen wallpaper is still there — dimmed to 32% behind the glass — and `omarchy theme bg set …` keeps working.

Bind the fullscreen overlay and wallpaper-dashboard toggle in `~/.config/hypr/bindings.lua` (pick any free chords):

```lua
o.bind("SUPER + D", "Infomarchy: AI info desk", "omarchy-shell shell toggle nixfred.infomarchy '{}'")
-- Hide the cards to see the plain desktop; press again to restore them.
o.bind("SUPER + I", "Infomarchy: toggle wallpaper dashboard", "omarchy-shell infomarchy toggleDashboard")
```

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/nixfred/infomarchy.git ~/.config/omarchy/plugins/nixfred.infomarchy
omarchy-shell shell rescanPlugins
omarchy plugin enable nixfred.infomarchy
omarchy restart shell
```
</details>

## Remove

Remove Infomarchy and return to the stock wallpaper service with:

```bash
omarchy plugin remove nixfred.infomarchy --yes
omarchy restart shell
```

## Requirements

Omarchy Quattro with third-party shell plugin support, `bun` (ships with Omarchy), `iw`, `iproute2`, and `ping`. Optional: `nvidia-smi` (GPU row hides without it), the `omarchy.agents` bar widget (for the usage card), and Ollama (for the local-AI card). Hyprland 0.56+ (Lua dispatch) and older (`focuswindow`) are both handled.

## It follows your theme

There are no colours in this plugin. Infomarchy reads the active theme's `colors.toml` — `green`, `yellow`, `red`, `blue`, `cyan`, `magenta`, `foreground`, `background` — and falls back to Omarchy's `Color` singleton for anything a theme leaves out. Fonts and spacing come from Omarchy's `Style`, so `omarchy display text size` scales the desk too. Switch themes and the desk re-skins in place.

The screenshots above are the **Last Call** theme. A theme gallery is on the roadmap — PRs with your theme's screenshot are very welcome.

## How it works

```
┌──────────────────────────────┐      every 4 s       ┌────────────────────────────────────┐
│ collector.ts  (bun, ~0.2 s)  │ ───── JSON ────────▶ │ InfoModel.qml                      │
│  /proc  /sys  hyprctl        │                      │  runs collector · parses snapshot  │
│  ~/.claude/history.jsonl     │                      │  reads theme colors.toml           │
│  ~/.codex/*.jsonl            │                      └──────────────┬─────────────────────┘
│  ~/.grok/active_sessions.json│                                     │ desk: InfoModel
│  ~/.local/share/opencode/*.db│                                     │
│  Ollama /api/ps /api/tags    │               ┌─────────────────────┴───────────────────┐
│  omarchy agents usage cache  │               │ InfoView.qml  (cards, heatmap, meters)  │
│  iw · ip · ping · nvidia-smi │               └───────┬───────────────────────┬─────────┘
└──────────────────────────────┘                       │                       │
                                     Infomarchy.qml ◀──┘                       └──▶ Overlay.qml
                                     service · WlrLayer.Background                 overlay · SUPER+D
                                     (clonedFrom omarchy.background)               WlrLayer.Overlay
```

- **`collector.ts`** builds one snapshot. It reads `argv` for every pid (cheap), then lazily opens only agent processes and their ancestors, so a 1 000-process box costs ~0.2 s warm. Local files are opened once with no-follow/nonblocking semantics, must be regular files, and are read under byte/time limits. Rate baselines use private, atomic state files under `$XDG_STATE_HOME/infomarchy/prev-<instance>.json`. It never parses the multi-hundred-MB Claude/Codex session transcripts — only the small history/index files and OpenCode's local SQLite history.
- **`resume-session.ts`** maps each supported provider to its installed CLI resume syntax and launches it through `xdg-terminal-exec`. Provider, ID, and project are separate process arguments; prompt text is never executed.
- **`InfoModel.qml`** owns the timer, the parse, the theme colours, and helpers (`focusWindow`, formatting).
- **`InfoView.qml`** is pure presentation, hosted twice: on the **background** layer by `Infomarchy.qml`, and on the **overlay** layer by `Overlay.qml`. The background host keeps the `background` IPC target so Omarchy's wallpaper tooling is unaffected.

### Portable by design

No usernames, hostnames or absolute paths are hardcoded anywhere. The collector honours `HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `OLLAMA_HOST`; every source is optional and degrades to "not present" rather than failing. If you don't use Grok or OpenCode, its tag just never appears.

## Tuning

```bash
omarchy-shell infomarchy refresh                                      # wallpaper collector now
omarchy-shell shell call nixfred.infomarchy refresh                   # overlay collector (only while summoned)
omarchy-shell infomarchy setWallpaperOpacity 0.5                      # 0 = solid theme bg
omarchy-shell infomarchy toggleDashboard                              # hide/show cards; keep wallpaper
omarchy-shell infomarchy setDashboardVisible true                     # explicit on/off control
omarchy-shell infomarchy toggleSection machine                        # remove/restore one dashboard card
omarchy-shell infomarchy setSection recent true                       # explicit section visibility
omarchy-shell infomarchy setDemo true                                 # sanitized screenshot data; transient
omarchy-shell infomarchy setDemo false                                # return to live local data
```

| Knob | Where | Default |
|---|---|---|
| poll interval | `refreshMs` in `Infomarchy.qml` / `Overlay.qml` | 4000 / 3000 ms |
| wallpaper dim | `wallpaperOpacity` in `Infomarchy.qml` | 0.32 |
| wallpaper dashboard | `SUPER+I` or wallpaper IPC above; state survives shell/plugin restarts | visible |
| space left for the bar | `topInset` in `InfoView.qml` | 40 px × font scale |
| provider colours | `providerColor()` in `InfoModel.qml` | theme ANSI roles |
| add a provider | one regex in `PROVIDERS` in `collector.ts` | — |

## Data handling

Prompt and session data stays on the machine. Network checks are limited to the existing ping to `1.1.1.1`, the local Ollama API, and a Cloudflare trace request for the public IP at most once every 15 minutes per dashboard surface. Recent task text is credential-redacted before it reaches QML. Collector JSON is depth/node/byte bounded and streamed to QML in capped frames. Infomarchy has no screen-level privacy masking: prompts, projects, paths, host/network details, and session topics remain visible. The explicit `setDemo true` screenshot mode replaces the whole snapshot with documentation-only sample data and resets off whenever the shell restarts.

## FAQ

**Does it drain my battery?** One `bun` run every 4 s (~0.2 s of CPU warm), no idle animation except the busy-dot pulse — a few percent of one core at most. Raise `refreshMs` if you want it lower.

**The desk is black / empty.** You changed QML and the shell didn't reload the service — run `omarchy restart shell`. (`collector.ts` changes are picked up live.)

**Clicking a card doesn't focus anything.** The card says *no window* — the agent isn't under a Hyprland client (SSH session, systemd service, or started from a launcher that already exited). That's expected.

**Can I keep the stock wallpaper behaviour too?** Yes: disable `nixfred.infomarchy` and Omarchy restores `omarchy.background`. Or keep it enabled and set `wallpaperOpacity` to taste.

**Two monitors?** One desk per screen, each sized to its own resolution.

## Roadmap

- [ ] Per-card show/hide in the plugin settings schema (no QML editing)
- [ ] Task board from Claude Code `TaskCreate` / Codex goals, with completed-task history
- [ ] Fleet row: other hosts' AI load over SSH/Tailscale
- [ ] Memory / vector-store growth sparkline (qdrant, LMF, …)
- [ ] Theme gallery in this README — send yours

## Contributing

Issues and PRs welcome. The one rule: **nothing machine-specific** — if it needs your username, your path or your hostname, it needs to come from an env var or `/proc`. Adding a provider is a regex in `collector.ts` plus a colour/label in `InfoModel.qml`; please include a redacted sample of the data you're reading.

## Credits

Built on the [Omarchy](https://omarchy.org) shell by DHH and contributors, [Quickshell](https://quickshell.org), and [Hyprland](https://hyprland.org). The usage card stands on the shoulders of Omarchy's `omarchy.agents` widget.

Made by [Fred Nix](https://github.com/nixfred) with Larry, Atlanta, 2026.

## License

[MIT](LICENSE)
