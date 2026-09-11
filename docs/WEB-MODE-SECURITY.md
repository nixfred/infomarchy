# Web Mode security design

Implemented design agreed on 2026-09-09, verified on 2026-09-10. See [HANDOFF.md](HANDOFF.md) for the source map and validation record, and [README setup](../README.md#set-up-web-mode) for user instructions.

## Scope and rationale

Web Mode supports three mutually exclusive access modes: trusted LAN HTTP, private HTTPS through Tailscale Serve, and direct Manual HTTPS with existing certificate files. Desktop-owned privacy is enforced before responses leave the server. Network reachability, transport encryption, and viewer-token authorization are separate checks.

For Tailscale mode, Tailscale owns private connectivity and HTTPS certificate lifecycle; Infomarchy owns disclosure, viewer credentials, and its forwarding process. Manual HTTPS delegates issuance, DNS, client trust and renewal to the operator. Neither mode requires DNS-provider credentials, trust-store installation, or certificate renewal machinery inside the plugin. Public exposure, Funnel, built-in CA/ACME, pairing-to-cookie sessions, and per-viewer roles are outside this implementation. They are not pending approved requirements.

## Disclosure policy

Only literal boolean `false` in persisted desktop `privacyMode` disables privacy. Missing, unreadable, invalid, or malformed settings default to on. Desktop preference changes are field-specific patches, including per-key map edits, rather than cached whole-file snapshots. `dashboard-state.ts` merges each patch into freshly read settings under `dashboard.lock`; the browser layout writer uses that same transaction. Unrelated stale desktop/browser edits cannot restore privacy-off, WEB-on, or a previous access mode. Each QML instance queues writes through startup and reloads persisted state after completion; failures are visible and reload saved settings.

The browser's privacy label is read-only; the layout preference endpoint rejects unexpected keys, including privacy mutations.

`filterWebSnapshot` applies a shared disclosure policy to HTML and JSON without modifying the desktop source snapshot. With privacy on, it omits WAN/LAN addresses, SSID and user/host identity, shortens home mounts, and truncates recent prompts after four words using the existing mask. Hidden elements, attributes, scripts, and JSON must not retain full values. Session topics, project names, and short prompts remain visible by design; this is partial disclosure, not comprehensive anonymization.

GitHub login remains excluded at either privacy setting. JSON sessions, attention, and usage are projected to web fields rather than forwarding desktop action arguments, working directories, previews, or extra provider data. Desktop COPY EXCERPT retains full text.

Privacy off permits connected viewers to receive the allowed full values. Changes apply to subsequent responses, normally the next successful five-second refresh. Already received/saved data cannot be retracted; disconnected pages may retain old content. Privacy filtering does not encrypt HTTP transport.

## Access boundaries

### LAN HTTP

An unknown explicit persisted mode keeps WEB off until a supported mode is chosen. Only an absent legacy mode defaults to LAN. Advertised LAN addresses follow default-route metrics, excluding non-default virtual bridges; source authorization is still checked separately.

The backend binds IPv4 `0.0.0.0`, default port 8787. Source defaults are loopback and RFC1918, with explicit extra CIDRs available. `100.64.0.0/10` is not default-allowed and never proves tailnet membership. CIDRs are reachability filters. The user manages firewall rules; loading settings or enabling WEB does not change them. Data and bearer credentials travel unencrypted.

### Private HTTPS

The backend binds `127.0.0.1`. A dedicated foreground `tailscale serve --https=8788 http://127.0.0.1:8787` process provides private HTTPS. The application requires a loopback TCP peer, the exact HTTPS Host/Origin derived from local Tailscale status, and a valid viewer token. It does not trust forwarded or Tailscale identity headers. A local process holding a token can access loopback with the correct Host; this does not isolate the service from other processes running as the user.

Inspection checks the installed CLI, connection, DNS name, required Serve options, and existing Serve configuration using bounded subprocesses. Existing TCP/Web/Funnel mappings on 8788, including nested foreground mappings, cause refusal. Unrelated services are preserved. No existing background mapping is adopted, no global Serve reset is run, and Funnel is never enabled.

`web-child.py` sets Linux parent-death SIGKILL and checks the parent PID before executing the CLI. Normal listener shutdown and abrupt listener death terminate the owned process; tailscaled removes its foreground mapping when the CLI connection closes. Plugin removal ends that ownership too. Tailscale itself and unrelated services continue running.

Startup waits for the expected foreground mapping and verifies that it is not Funnel before reporting ready. A failed setup exits without LAN fallback. Selecting another access mode turns WEB off. Installation, login, admin HTTPS/MagicDNS changes, and local permissions are guided rather than automatically changed or escalated.

### Manual HTTPS

README includes an operator-run private-CA/IP-SAN recipe for LAN viewing without DNS or Tailscale. It keeps key material outside the public download directory, limits incoming firewall rules, requires deliberate client CA trust and documents renewal/removal. Those manual steps do not add certificate or firewall management to the plugin.

`web-manual.ts` loads a bounded existing PEM chain and unencrypted PEM private key. Configuration contains a DNS hostname or private IPv4 identity, a specific loopback/private IPv4 bind address, an unprivileged port (default 8789), file references and the expected SHA-256 leaf-certificate fingerprint. Public and wildcard binds are rejected. A VPN bind does not confer source authorization: the existing CIDR allow list still applies. DNS configuration and reachability remain operator-owned.

Every file path component is opened through held parent descriptors without following symlinks; parents must be owned by root/the current user and protected against unrelated writers (root-owned sticky temporary directories are allowed). Final files are descriptor-validated for type, owner, link count, permissions and bounded size. Keys must have no group/other permissions. The same validated bytes are passed into TLS; there is no later pathname reopen. Crypto errors are replaced by bounded fixed diagnostics, never PEM content.

Startup checks the exact leaf fingerprint, validity of each supplied certificate, DNS SAN coverage for hostnames or exact IP SAN coverage for literal addresses (no CN fallback), matching private key, leaf-not-CA, and supplied issuer signatures/CA flags. This binds the configured identity to the certificate being served; it neither establishes browser trust nor changes signed hostname coverage. Clients perform their own trust-chain verification. A self-signed leaf may be supplied if clients deliberately trust it. A renewal requires an explicit fingerprint update and restart; running TLS continues using its loaded bytes. Expired loaded certificates stop application responses immediately and stop the listener within 30 seconds.

The listener requires the exact configured HTTPS Host/Origin plus source authorization and a viewer token, without trusting forwarded headers. Browser mutation remains layout-only. Manual settings are desktop-owned, saved through the shared settings transaction, and saving them while Manual HTTPS is selected disables WEB. Read-only CHECK CERTIFICATE does not start sharing or mutate certificates. A rejected setup never opens an HTTP fallback. No trust store, DNS, firewall, CA, issuance or renewal management is performed by the plugin.

## Credentials, requests, and UI

Setup and viewer management are desktop controls in the dashboard SETTINGS drawer. This contribution does not register a bar widget.

Viewer tokens are individually revocable bearer credentials stored in `web.json` with mode 0600. Credential reads validate the opened descriptor, ownership, link count, mode, and bounded size; symlinks and invalid files fail closed. Rejected state is not silently replaced with new credentials or stale cached tokens. All credential mutations (creation, token add/revoke, CIDR changes, and enable/disable) acquire `web-config.lock` before reading and retain it through atomic publication. The whole-config writer is private to those transactions, so an unrelated update cannot restore a revoked token from a stale read. Revocation affects subsequent authenticated requests. WEB off keeps credentials; add a replacement before revoking the last token.

Page access is GET/HEAD. The JSON-only POST `/prefs` requires the expected Origin and accepts only `webSections` and `webNarrowOrder`. Existing escaping, request limits, authentication, no-store responses, and nonce CSP remain. `connect-src 'self'` and `img-src 'self'` restrict page fetches. Rate-limit bookkeeping is bounded and distinguishes authenticated viewers behind the loopback proxy.

`web-status.json` contains noncredential runtime state validated against the live process identity. Routine startup/status output and QML polling contain no token URLs. Deliberate COPY URL/SHOW QR fetches the selected viewer address; `copyWebUrl` replaces URL-returning IPC. QR is cleared when hidden, settings closes, or the selection/mode changes. Dashboard QR opens the authenticated page; it does not enroll or authorize a Tailscale device.

Requested-on, starting, ready, and failed are distinct UI states. WEB FAILED offers RETRY SETUP after the user fixes a prerequisite; CHECK PREREQUISITES only inspects. Retry uses the service-owned listener lifecycle, preserves WEB-off guards, and ignores duplicate/ready retries. Preflight checks are hidden during starting/ready to avoid treating the owned active mapping as a conflict.

The two lock files are persistent empty 0600 files validated through their opened descriptors. Locks are kernel-owned, have a bounded acquisition wait, and release on descriptor close/process death; lock files are never unlinked or replaced during normal operation. Invalid locks and failed writes fail closed. Locks coordinate participating Infomarchy writers, not arbitrary same-user programs editing state outside the protocol.

## Validation expectations

For future changes, test distinctive private sentinels against actual HTML/JSON response bytes, privacy transitions, allowed four-word/topic disclosure, and browser mutation attempts. Exercise competing real helper processes and stale QML instances, privacy/WEB-off preservation, revocation during other credential mutations, lock rejection/crash release, and write-failure recovery. Preserve credential/revocation, Host/Origin, CSP, malformed-state, bounded-output, and shutdown tests. Exercise absent/stopped/signed-out Tailscale, conflicts, setup failures, repeated enable/disable, direct-backend boundaries, and crash cleanup. For Manual HTTPS, exercise a real TLS handshake with client trust enabled, SAN/key/fingerprint/expiry failures, unsafe file paths and permissions, Host/Origin/source/token checks, absence of HTTP fallback, and QML save/check/mode-switch behavior. Unit/mocked tests do not replace real-device or QML verification; current evidence and limits are recorded in HANDOFF.

Real-device evidence: the user confirmed Android access using the private-CA/IP-SAN setup after a scoped inbound firewall rule, then confirmed access through the restored Tailscale URL. Local probes alone had missed the inbound firewall block. The temporary CA download service and test firewall rule were removed afterward; this validates the exercised setup, not every client trust store or network. See HANDOFF for automated checks and remaining limits.

Reference: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [HTTPS prerequisites](https://tailscale.com/docs/how-to/set-up-https-certificates).
