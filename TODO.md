# Infomarchy interactive command-desk roadmap

Work is deliberately sequential. A feature may move to `done` only after its
unit tests, collector snapshot, QML/runtime load, live behavior, data safety, and
performance checks are clean. Before the next feature starts, its interaction
and screen placement are described in the work log/conversation.

## Screen architecture

- Target the real baseline display: 1920×1080 at scale 1.
- Keep one compact module strip above the existing two-column overview.
- Every full card is a registered module and can be removed/restored from the
  strip; choices persist in the Infomarchy state file.
- New detail-heavy features use drawers, popovers, filters, or hover previews.
  They do not permanently add another vertical card to the overview.
- The recent-task list remains the flexible-height section and absorbs layout
  changes without forcing the dashboard off screen.
- Background and fullscreen-overlay views share the same module preferences.

## Quality gate for every feature

- [x] Unit tests cover success, unavailable-data, stale-window, and malformed-data paths.
- [x] Collector emits valid, credential-redacted JSON with optional providers absent.
- [x] QML loads without runtime warnings or binding errors.
- [x] Live behavior is verified against a real Hyprland client when applicable.
- [x] Prompt text remains credential-redacted before display.
- [x] Collector runtime and output size remain reasonable for the 3–4 second poll.
- [x] README documents the behavior and controls.

## Sequential features

- [x] Foundation: persistent add/remove controls for every section.
- [x] Gate 0: live prompt rows focus their exact session window.
- [x] 1. Closed-session Resume for Claude, Codex, Grok, opencode, and other safely supported providers; add opencode history/live tracking.
- [x] 2. Clickable heatmap filtering by hour and provider.
- [x] 3. Expandable live-session inspector and safe window/project actions.
- [x] 4. Workspace focus/move actions; the later duplicate compact map was retired in favor of large cards only.
- [x] 5. Needs You inbox with faint glow, focus, snooze, and dismiss.
- [x] 6. Prompt-row actions: focus/resume, copy, pin, session grouping, and project open.
- [x] 7. Per-agent CPU, RAM, process, and GPU attribution.
- [x] 8. Interactive usage forecasting, display modes, and provider filtering.
- [x] 9. Optional blurred still window previews on hover.
- [x] 10. Global command strip and keyboard navigation.
- [x] Final complete regression, performance, data-safety, and documentation pass.

## Follow-up batch

- [x] 11. Recent Tasks: 80-row scrollback, text/project/provider search, and a visible, draggable scrollbar.
- [x] 12. Activity: show the hovered cell breakdown beside the pointer instead of in the far-right legend.
- [x] 13. Network: display the host's external IP and cache success/failure responsibly.
- [x] 14. Persistence: SUPER+I visibility survives Infomarchy and unrelated shell/plugin restarts without flipping.
- [x] 15. Layout: persistently reorder Usage, Local AI, and Machine with snappy vertical drag-and-drop.
- [x] 16. Local AI controls: select, load, and unload installed Ollama models safely from the card.
- [x] 17. Live-session topics: derive exact-session context for each large agent card.
- [x] 18. Recent Tasks scrolling: route wheel/touchpad input directly through clickable rows and enlarge the draggable track.
- [x] 19. Recent Tasks input fix: replace row-covering MouseAreas with non-blocking hover/tap handlers and accelerate smooth scrolling.
- [x] 20. Live-session cleanup: remove the duplicate compact workspace/session strip and keep only large per-session cards.
- [x] 21. Real session synopsis: summarize several exact-session requests into a short phrase, optionally refined by an already-loaded Ollama model; never display the last prompt as the topic.
- [x] 22. Proactive alerts: persistently deduplicate attention, crash, review, and ended-session notifications with global, quiet-hours, and per-provider controls.

- [ ] Settings ownership: wallpaper and overlay each hold an InfoSettings copy of dashboard.json and write the whole file; two near-simultaneous writes (a notification claim + a section toggle) can clobber one another. Centralize writes in the service or read-merge-write with a revision. (Second-reviewer finding, 2026-09-05.)
