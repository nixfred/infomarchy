# Web Mode maintenance handoff

README owns user-facing setup instructions; WEB-MODE-SECURITY.md owns implemented boundaries and rationale. This proposal is rebased onto upstream `e2028e5` (post-1.4.1 master, 2026-09-18) and preserves `nixfred.infomarchy`, upstream installation instructions, desktop modules and provider collectors. It adds Web Mode, desktop privacy controls and the state transactions they require. It does not add containers, provider billing changes or a bar widget. Upstream media controls, Pi and the persisted LOCAL AI origin remain available on the desktop; media is excluded from Web Mode. The Ollama origin now saves through the shared settings transaction. Web Mode setup is accessed through the dashboard SETTINGS drawer.

## Source map

| Component | Responsibility |
| --- | --- |
| `web-page.ts` | Browser rendering, desktop-owned privacy filtering, theme, layout preferences and narrow-screen ordering. |
| `web-server.ts` | LAN/TLS listeners, source/Host/Origin/token checks, bounded credential reads, revocation, layout-only POST and noncredential status. |
| `web-tailscale.ts`, `web-child.py` | Read-only preflight, owned foreground Serve mapping, bounded CLI output, failure/retry and parent-death cleanup. |
| `web-manual.ts` | Existing PEM/key descriptor validation, SHA-256 leaf pin, DNS/IP SAN, key/date/chain checks and private-interface TLS. |
| `InfoSettings.qml`, `dashboard-state.ts`, `state-lock.ts` | Field/per-key patches under `dashboard.lock`, queued saves and launch/exit failure recovery. Credentials use a separate `web-config.lock`. |
| `Infomarchy.qml`, `SettingsBody.qml` | Service-owned lifecycle and retry IPC, overlay settings, deliberate clipboard and QR actions. |
| `collector.ts`, `InfoView.qml`, `Overlay.qml` | Snapshot publication while Web Mode is enabled; desktop privacy controls, prompt masking, settings entry and hotkeys. |

## Invariants

Never print viewer token URLs or credential/key files. GET/HEAD serves the page; POST `/prefs` requires JSON and the exact Origin and changes only web layout. Missing/invalid privacy defaults on. Browser controls cannot change privacy. Modes are mutually exclusive; changing mode turns WEB off. Unknown explicit saved modes keep it off; missing legacy mode defaults to LAN. The requested, starting and ready states are distinct; failed setup exposes retry.

All settings writes merge patches under the shared lock; never replace state with cached QML snapshots. Persistent lock files must not be unlinked. Helper launch failure must recover even without Process.exited. Every credential mutation reads inside its lock. WEB off preserves tokens; explicit revocation invalidates a viewer.

Serve owns only its foreground mapping on 8788 and a loopback backend; never reset unrelated mappings or enable Funnel. Manual HTTPS has no built-in issuance, DNS, trust-store or firewall management. README's OpenSSL recipe is operator-run. Certificate expiry blocks responses and stops the listener; renewal requires updating the pin and restarting.

## Verification — 2026-09-10

- Final proposal without the bar widget: `bun test --timeout 30000` passed 247 tests across 20 files. Collector fixture subprocesses use `process.execPath` so they run the current Bun binary even with an isolated HOME. The longer per-test deadline avoids the default five-second timeout on hosts where collector fixtures run slowly. No Web assertions were relaxed.
- Tests include certificate-verified TLS for DNS and IP identities, Host/Origin/source/token/privacy boundaries, Tailscale failures and cleanup, actual offscreen QML retry, stale writers, failed writes, invalid mode rejection and failed helper launch followed by recovery. Missing QR/clipboard binaries fail gracefully.
- Chromium against an isolated actual listener: 390px layout fit without horizontal overflow; privacy on/off/on changed response rendering through the actual five-second HTML swaps. Test data was synthetic and viewer URLs were never logged. Installed qrencode also generated a valid synthetic viewer matrix.
- Actual upstream InfoView, InfoSettings and InfoModel rendered the Manual HTTPS settings panel at 1920×1080 in an offscreen QML harness. Theme singletons were stubbed; no matching QML runtime errors were observed. Native clipboard success and a fresh phone install of this extracted branch were not exercised.
- README's OpenSSL recipe was executed in isolated storage during source preparation and verified the generated IP certificate. Prior real-device evidence for the source implementation: the user verified Android Manual HTTPS after CA installation and a scoped firewall correction, then verified restored Tailscale. This is separate from validation of the extracted branch.
- Desktop-local probes do not exercise inbound firewall rules. Bun's live probe rejected the name-constrained test CA with `UNSPECIFIED`; independent OpenSSL/curl/Chromium verification and the Android test succeeded. Client trust compatibility remains a client responsibility.
- `git diff --check` passed. No public exposure, live desktop replacement, local PKI or credential-bearing artifacts are part of this contribution.

## Rebase verification — 2026-09-11

Rebased onto upstream `9726812` (1.4.1). Preserved upstream media, Pi, provider recognition, animated wallpapers and the persisted Ollama origin. The origin setter now submits a field patch; the real offscreen competing-writer test verifies it saves alongside privacy, WEB-off and layout changes. Media remains desktop-only and the bar widget remains excluded.

`PATH=/usr/bin:$PATH bun test --timeout 30000`: 280 passed, 0 failed across 22 files, including syntax and real-import QML gates, offscreen QML lifecycle/settings tests, and actual TLS/privacy tests. Import-resolution ceilings account for the settings drawer and its Process handlers/dynamic Style properties; they do not claim zero warnings or visual validation. `git diff --check` passed. No live deployment or new phone verification was performed.

## Rebase verification — 2026-09-18

Rebased onto upstream `e2028e5`, 29 commits past 1.4.1: Kimi Code and Cursor providers, Hermes module-form detection, quiet-session grouping, the GITEA heatmap, the pointer-reach and wallpaper render gates, the 4.0.3-safe resolved-import gate and `INFOMARCHY_SKIP_REFINEMENT`. Conflicts were inside this proposal's own choices: the new `sessionGroups`, `sessionQuietMinutes` and `videoAudio` settings save through the same locked field-patch writer as every other setting (validator extended, whole-config `persist()` stays removed), the grouped session card's working-directory line goes through `displayPath` so desktop privacy still masks home paths, and the changelog keeps both sides. `ai.gitea` is not sent to browsers because it carries the Gitea login; GITEA stays a desktop card.

`PATH=/usr/bin:$PATH bun test --timeout 30000`: 336 passed, 0 failed across 26 files. Privacy defaults off on desk and browser alike (only a saved literal `true` masks), and window titles are masked with cwd. Import-resolution ceilings were re-measured on this tree (InfoView 509, Infomarchy 27, InfoSettings 2, Overlay 29, SettingsBody 151); each equals upstream's count plus this proposal's own delta. Media, Cursor and Gitea were not exercised live.
