# Slack vs Google Chat: current N-to-N integration comparison

Audit date: 2026-08-16

Repository: Centaur
Production release: `c8f1df8bf10e5e337e854fa71154c7f4a781ee32`
VPS GitOps release: `6f55ddea2472bdf1cffedc3de6fa750ede96dded`

## Scope and status

This compares the outcomes Centaur implements, not every feature available in
the Slack and Google Workspace products. It covers ingress, identity,
permissions, spaces/channels, DMs, threads, messages, actions, reactions,
rendering, files, agent tools, historical ingestion, privacy, durability,
deployment, metrics, administration, and verification.

Status terms:

- **Parity** — equivalent user/security/operational outcome for the platform.
- **Different by design** — deliberate platform-native behavior with no missing
  required outcome.
- **Google-native extension** or **Slack-native extension** — a useful surface
  exists only on one side and is outside the current parity requirement.
- **Parity gap** — the reference integration provides a Centaur outcome that
  the other integration should provide under the agreed scope but currently
  does not. Merely existing in Google's API is not enough to create a gap.
- **Implemented; live pending** — code and deterministic checks exist, but a
  Google-controlled, Kubernetes, or browser acceptance gate is still missing.

Google Chat parity is **not yet exhaustively verified**. The current production
release closes the identified code gaps and passes real Workspace DWD, file,
reaction, Drive, and ETL checks, but signed inbound and several explicit
boundary/convergence/browser scenarios remain. The release truth is
`docs/google-chat-parity-verification.md`; a pending row is not a pass.

## Executive comparison

The core and agent-facing outcomes are now close: both integrations have signed
ingress, exact conversation permissions, discovery/history/thread tooling,
DM send, reactions for analysis, upload/download, durable state, recovery,
health, metrics, historical ingestion, private-data controls, and CI fixtures.

The remaining differences are primarily platform-native:

1. Slack signs the request body; Google's Chat JWT authenticates the caller but
   does not bind the event body. Only a verified Add-on `userIdToken` supplies a
   human email, and Centaur additionally confirms the 1:1 DM with `spaces.get`
   before releasing that identity.
2. Slack provides a streaming/assistant surface. Google Chat uses one thinking
   message, bounded status edits, and canonical single- or multipart final
   delivery.
3. Slack uploads are bot-authored. Google Chat media uploads use a dedicated
   DWD human subject and are authored by that user.
4. Google Chat exposes scoped update/delete of app-owned messages to agents;
   Slack's agent CLI has no generic equivalents.
5. Slack has user groups, export-ZIP ingestion, Slack Connect delayed-file
   repair, and a broad workspace user directory. These are Slack-specific and
   are not cloned into Google Chat.
6. Google Chat's DWD, upload/download, reaction, Drive, mutation, and shared/DM
   ETL paths now have production Workspace evidence. Google-signed interaction
   ingress remains externally blocked at the Chat API connection/audience
   configuration.
7. The current ETL requests `showDeleted=true` for both app-authenticated shared
   spaces and delegated DMs. Automated tombstone cleanup exists, but both paths
   still need live create→sync→delete→resync evidence.

### Difference classification

The remaining **Slack outcome deltas** are narrower than the list of Google APIs
Centaur does not implement:

- Google agent search is a bounded history scan and can report `truncated`;
  Slack can use native/user-token search. Corpus-scale completeness is therefore
  not identical.
- Google hydrates at most 10 inbound attachments per message versus Slack's 20,
  and Google ETL retains official attachment metadata rather than Slack's richer
  searchable/downloaded attachment content.
- Google Vids content remains metadata-only because Drive requires the
  unimplemented long-running `files.download` flow; ordinary Slack-uploaded
  video bytes can use the normal Slack file path.
- Shared-room Google events deliberately do not release a human email or
  personal credential. Slack can retain a verified home-team requester
  principal in that context.

These are explicit, non-blocking plan decisions unless product scope changes.
Separately, App Home, `widgetUpdatedPayload` suggestions, dialog UI responses,
link previews, native Chat search/events, named-space administration,
membership writes, reaction writes, and pins are **Google-native unimplemented
capabilities**. They are not Slack parity gaps because Centaur's Slack agent
surface does not provide the matching outcome. True streaming, Chat thread
titles, email-rich Chat directory resources, and Slack-only objects are
**platform gaps**, not missing Google API work.

## 1. Authentication, permissions, identity, and credentials

| Capability | Slack | Google Chat | Current difference |
| --- | --- | --- | --- |
| Inbound authentication | Mandatory Slack signing secret and body-bound HMAC through the adapter. | Google-signed bearer JWT required by default; three explicit modes pair issuer, JWK set, exact project-number or URL audience, signer identity, numeric `iat`/`exp`, and maximum age. | Parity in authentication outcome; Google token is not body-bound. Live signed-token matrix pending. |
| Replay and duplicate defense | Durable event/action state and api-rs idempotency. | Durable Postgres event/action dedupe; action key includes event time, space, message, user, function, and canonical parameters. | Parity implemented; cross-replica live test pending. |
| Sender domain/org gate | External-team and trigger-bot allowlists. | Optional email-domain allowlist over a verified Add-on `userIdToken`; Chat API `User` resources have no email, so Chat API modes cannot satisfy it. | Different identity models. Domain filtering is explicitly secondary to JWT authentication. |
| Canonical bot identity | Slack app/user identity from adapter/API; self and non-allowlisted bot events suppressed. | `spaces.members.get`/canonical Chat app member identity; exact mentions accepted, self and other bots suppressed. | Parity implemented; live `members/app` response pending. |
| Human identity in shared room | Home-team Slack requester can contribute a separate requester principal. | Shared spaces/group chats deliberately suppress requester email and use only the space principal. | Slack-native identity extension; Google chooses the safer body-not-bound model. |
| Human identity in 1:1 DM | Stable user principal. | Verified Add-on user token + allowlist + `spaces.get` confirmation can label the DM principal and DWD history subject. Legacy Chat API events carry no verifiable human email. | Partial parity; live Add-on identity proof pending. |
| Conversation grants | Exact Slack conversation IDs with independent upload/download/history flags, on principals or roles. | Exact `spaces/<id>` with independent send/update/delete/upload/download/history/members/reactions flags, on principals or roles. | Google has broader operation coverage; Console and proxy tests pass, live JWT check pending. |
| DM target grant | Agent can open a DM with a resolved Slack user. | Separate exact-email setup grant; resource-name and legacy `users/<email>` targets are rejected. api-rs creates/reuses and sends without exposing the returned space as an arbitrary target. | Parity outcome; Google uses an explicit target allowlist. |
| Grant merge/cache | Direct and role grants contribute effective claims and invalidate principal configuration. | Same OR merge and cache invalidation. Targets are immutable; duplicate/empty rows rejected. | Parity. Google actual browser interaction pending. |
| Sandbox credential | Slack secrets are resolved/injected at the proxy or retained in api-rs paths. | Sandbox gets a short-lived Console JWT only; api-rs validates exact resource/operation and alone holds the internal bot credential. | Parity in secret isolation; Google topology is uniformly proxied. |
| Internal network boundary | Slackbot/API paths are chart-restricted. | NetworkPolicy allows api-rs to googlechatbot and excludes sandbox/workflow selectors; `/api/chat/*` also requires a timing-safe bearer check. | Implemented; live Kind allow/deny and internal-auth checks pass. |
| Runtime app credential | Slack bot token plus signing secret. | Service account with `chat.bot` and admin-approved `chat.app.messages.readonly`. | Platform-specific. |
| Delegated credentials | Optional Slack user/search/OAuth tokens. | Fixed DWD subjects for upload (`chat.messages.create`), reactions (`chat.messages.reactions.readonly`), and Drive (`drive.readonly`); the validated target is the DM-setup subject (`chat.spaces.create`), and the verified requester is the DM-history subject (`chat.messages.readonly`). | Platform-specific; DM targets/requesters must be impersonable same-domain Workspace users. |
| Missing advanced credential | Operation fails or returns missing-scope error. | Upload/DM/reaction fail closed; Drive content degrades to metadata; requester DM history degrades without claiming another user. | Parity in least privilege. |
| Global user directory | Slack tool lists/searches users and resolves profiles/emails. | Deliberately absent; space membership and explicit DM targets cover required operations. | Accepted Slack-native extension; avoids broad Admin SDK Directory scope. |

## 2. Channels/spaces, DMs, threads, and context

| Capability | Slack | Google Chat | Current difference |
| --- | --- | --- | --- |
| Named room ingress | Channels/private channels where the app is present. | Named `SPACE` where the app is installed/member. | Parity. |
| Group conversation ingress | Multi-party `G...` conversation. | `GROUP_CHAT`. | Parity. |
| 1:1 DM ingress | `D...` conversation maps to user principal. | `singleUserBotDm`/confirmed `DIRECT_MESSAGE` maps to DM principal; no mention required. | Parity. |
| Mention detection | Exact configured Slack bot ID in text/rich content. | Exact Chat annotation/resource identity; slash-command annotation is addressed. Ordinary `@alice`, another bot, and self produce no session call. | Parity implemented; live wire check pending. |
| Follow-up without mention | Subscribed-thread behavior; ignored messages can be included on next addressed turn. | Optional `GOOGLECHATBOT_FOLLOW_UP_THREADS`; accepted follow-up attachments are hydrated and included. | Google opt-in because the Chat app must receive all messages. |
| List rooms | Authorized channels plus direct variants and access flags. | Authorized `spaces` with pagination and access limited by JWT claims. | Parity for authorized discovery. |
| Room metadata | Channel name/topic/purpose/privacy/member count. | `space-info` returns Chat resource metadata/type. | Platform field differences only. |
| Members | Proxied/direct channel members and email-oriented helpers. | Paginated authorized space memberships. | Core parity; Slack has richer workspace-profile resolution. |
| Start/reuse DM | `slack dm` resolves user and opens/reuses a conversation. | `google-chat dm` accepts an exact granted email, impersonates that target for `spaces.setup`, creates/reuses the single-user bot DM, and sends the first message. | Parity; live DWD setup/reuse and user-authored create/delete passed. |
| Threads | Read/reply, stable thread key, refreshed context. | Read/reply by `spaces/.../threads/...`; fallback creates thread; every execution carries refreshed context. | Parity. |
| Thread history cap | Slack adapter/history policy. | Configurable 1–1000 messages, default 50; newest-biased execution context is capped at 24,000 characters. | Google has explicit documented caps. |
| Card/rich history | Slack blocks/attachments converted to context. | One shared fixture verifies exhaustive text extraction across the Cards v2 text-bearing union (including accessibility text, controls, grids, columns, carousels, chips, and footers) plus deprecated Cards v1 in both live and ETL paths. | Parity implemented for the discovery revision covered by the fixture; future schema revisions require fixture review. |
| Concurrent turn | Durable steering/session behavior. | Active-execution state folds a concurrent message into the run and removes redundant thinking output. | Parity implemented; live restart pending. |
| Stop/cancel | Mentioned stop/kill/end/cancel interrupts api-rs. | Same detector/interrupt route with stopped/no-active response. | Parity. |
| Sticky overrides | Harness/model/provider persist per thread; reasoning per turn. | Same persisted split; explicit flag, then sticky state/space default, then deployment default. | Parity. |
| Thread title | Native Slack assistant title. | No equivalent Chat thread-title API. | Accepted Slack platform advantage. |

## 3. Messages, commands, actions, reactions, and rendering

| Capability | Slack | Google Chat | Current difference |
| --- | --- | --- | --- |
| Ordinary prompt | Message/mention normalization including rich content. | Legacy `MESSAGE` and Add-ons message payloads; slash `argumentText` supported. | Parity implemented. |
| Slash command | Adapter routes; prompt/stop behavior through normalized content. | Slash annotation and Add-ons app-command payload become prompt/workflow input. | Google has a first-class Chat command shape; live payload pending. |
| Interactive action | Block Kit action becomes durable `slack.block_action.<id>` workflow event. | Legacy card/Add-ons button becomes durable `google_chat.card_click.<function>` event with canonical parameters. | Parity implemented; live Add-ons button pending. |
| Form submission | No separate generic Slack workflow beyond adapter/action paths. | Add-ons form submission becomes a typed durable workflow event. | Google-native extension; live form pending. |
| Reaction event | No turn handler. | No turn handler. | Parity: neither treats reactions as agent turns. |
| Reaction reads | Present in history/feedback analysis. | Message-qualified reaction API, summaries, dump, and feedback analysis. Shared scans use a fixed read-only subject; private-DM scans use the exact allowlisted DWD owner. | Parity; live shared/DM reads and zero-failure ETL persistence passed. |
| Add/remove reaction | No agent command. | No agent command. | Parity: intentionally absent. |
| Send | `slack send`, with channel/user resolution and optional thread. | Scoped `send-message`, exact space and optional thread through api-rs. | Parity. |
| Update | Renderer updates its own Slack response; no generic agent CLI. | Scoped `update-message` for app-owned messages. | Google-native extension, not a Slack parity requirement. |
| Delete | No generic agent command. | Scoped `delete-message` for app-owned messages. | Google-native extension, not a Slack parity requirement. |
| Dynamic widget suggestions | No equivalent agent/event surface. | Official Add-on `widgetUpdatedPayload` exists, but Centaur only recognizes the enum for safe logging and does not unwrap, dispatch, or answer it. | Google-native unimplemented capability; explicitly unsupported in this release. |
| Response streaming | Native progressive Slack stream, plans/tasks, continuation, reconciliation. | Thinking message + at most 1 Hz status edits. Text finals PATCH the acknowledgement; rich finals are created with a stable ID and fallback text, then the acknowledgement is deleted. | Different by design; Chat has no equivalent streaming primitive and does not allow `fallbackText` in a PATCH mask. |
| Long response | Slack continuation/segments and fallback clipping. | Complete serialized Chat messages stay within 32,000 UTF-8 bytes and overflow is split losslessly into ordered retry-safe parts; cards stay within 100 widgets and non-empty sections. | Equivalent outcome, different presentation. |
| Plain-text escape | Prompt can request plain text. | Same. | Parity. |
| Activity summary/status | Slack assistant status and detailed rendering. | Activity summary/status line; reasoning/task internals intentionally not exposed. | Slack richer presentation; no missing core outcome. |
| Empty/error/cancel result | Visible and durably reconciled. | Visible; durable canonical final with update then one replacement fallback. | Parity implemented; live restart pending. |
| Console link/metadata | Configurable first/always/never model, harness, reasoning, tier. | Equivalent controls in Chat response/card. | Parity. |

## 4. Files and attachments

| Capability | Slack | Google Chat | Current difference |
| --- | --- | --- | --- |
| Inbound file hydration | Slack files downloaded and typed. | `UPLOADED_CONTENT` downloaded through Chat media API; Drive files through a separate DWD Drive reader. | Parity; exact uploaded-content bytes/MIME and a live 75,979-byte XLSX Drive export passed. |
| Count per message | First 20. | First 10. | Slack higher; Google bound limits API fan-out. |
| File ceiling | 100 MiB. | 100 MiB decoded per file. | Parity. |
| Inline ceiling | Small files inline; large staged. | Inline through 25 MiB. | Implementation detail. |
| Large-file staging | Ordered `attachment.chunk` records with integrity metadata. | Same protocol with 700 KiB base64 chunks, size and SHA-256. | Parity implemented; boundary/hash live gate pending. |
| Aggregate turn ceiling | Bounded by Slack attachment policy. | Configurable, 100 MiB by default across decoded files. | Google explicitly bounded. |
| Follow-up attachment | Repaired/collected where appropriate. | Hydrated when opt-in follow-up mode accepts the turn. | Parity implemented. |
| Delayed file repair | Slack Connect-specific 15-second repair path. | Not required; Chat attachments arrive atomically. | Accepted Slack-specific workaround. |
| Drive-backed file | N/A. | Metadata-verified `drive.readonly` binary download; Docs/Sheets/Slides/Drawings/Apps Script use MIME/extension-correct `files.export` with a distinct 10 MB failure; unavailable access and Vids become metadata-only. | Google Vids require the unimplemented long-running `files.download` flow. Live export checks remain. |
| Upload | Direct/proxied Slack upload with richer file metadata. | Scoped upload through api-rs/bot, optional caption/thread, 100 MiB. | Core parity; Slack exposes more metadata. |
| Upload author | Bot. | Dedicated DWD Workspace user. | Platform credential difference. |
| File list/search | List and search direct/proxied. | `files` and bounded `search-files` derived from authorized message history. | Parity outcome; Slack API offers richer native filters. |
| File info | Proxy validates file/channel membership. | Exact message-qualified attachment metadata path and space grant. | Parity. |
| File download | Raw direct/proxy path; host validation; CLI ceiling. | Raw proxy stream, 100 MiB server ceiling, HTML rejection, sanitized filename, 10 MiB CLI default, no overwrite. | Parity implemented; live content-length/chunked checks pending. |
| File delete | Absent. | Absent. | Parity: absent. |
| ETL attachment | Metadata, optional bytes/status, projection. | Official message-qualified name/content-name/content-type/source metadata and raw payload; no invented text, byte-size, source-URI, or arbitrary raw-byte fetch. | Slack retains more searchable attachment content. |

## 5. Agent CLI surface

Typer changes Python function underscores to hyphens. This table groups aliases
that share an implementation.

| Slack command/outcome | Google Chat counterpart | Difference |
| --- | --- | --- |
| `health` | `health` | Parity. |
| `send` | `send-message` | Parity; Chat requires an exact granted resource. |
| `dm` | `dm` | Parity; Chat accepts an exact email target and performs setup + first send through one scoped proxy call. |
| `channel`, `channel-direct` | `list-messages` | Parity for paginated authorized history; Slack retains direct variants. |
| `thread`, `thread-direct` | `thread` | Parity for authorized thread history. |
| `channels`, `channels-direct` | `spaces` | Parity for authorized discovery; Google intentionally has no unscoped direct command. |
| Channel metadata | `space-info` | Parity for core resource metadata. |
| `channel-members*` | `members` | Core parity; Slack has extra email/profile helpers. |
| `users`, `search-users`, `user-info` | None | Accepted Slack-native extension; no broad Workspace directory. |
| `search` | `search` | Parity for bounded authorized text scan; Slack may use native/user-token search. |
| `questions` | `questions` | Parity. |
| `dump` | `dump` | Parity, including threads/reactions within configured bounds. |
| `feedback` | `feedback` | Parity for bounded text/reaction signals. |
| Reaction summaries in feedback/history | `reactions` | Parity read surface. |
| `upload`, proxy/direct aliases | `upload` | Core parity; different authorship. |
| `files` | `files` | Parity for message-derived attachments. |
| `search-files*` | `search-files` | Parity outcome with bounded local scan. |
| `file-info*` | `file-info` | Parity. |
| `download*` | `download` | Parity; both have scoped proxy paths and client bounds. |
| `sync-history` | ETL rather than local CLI state | Different architecture; Google keeps continuation server-side. |
| `usergroups`, create/update | None | Slack-only object, accepted exclusion. |
| None | `update-message` | Google-native extension; app-owned only. |
| None | `delete-message` | Google-native extension; app-owned only. |

Every Google Chat command now targets api-rs and uses the scoped
`CENTAUR_API_BEARER_TOKEN` sentinel/JWT path. The old direct Chat credential and
unreachable plain-HTTP relay design are removed from the agent boundary.

## 6. Historical sync, search corpus, and data lifecycle

| Capability | Slack | Google Chat | Current difference |
| --- | --- | --- | --- |
| Scheduled incremental sync | Per-channel watermark, overlap, exclusions, member checks. | Scheduled full rescan with durable page continuation; explicit manual `since` retains a create-time filter. This is required because Chat cannot filter by update time. | Edits converge; Google spends more reads. |
| Initial history/backfill | Dedicated durable backfill job queue. | Durable `nextPageToken` + exact filter in each checkpoint; positive page budget converges across runs. | Equivalent continuation outcome, simpler Chat-native design. |
| Discovery | App/user-visible channels; optional private channels. | App-member spaces or explicit pinned space IDs. | Platform-specific. |
| Default shared scope | Public/named selected channels; private/DM paths separate. | `SPACE` only by default. Group chats and DMs stay out of the company corpus. | Parity in privacy default. |
| Private ingestion | User-consented Slack DM/private pipeline. | Explicit allowlisted DWD subjects enumerate only their DMs. | Parity outcome with different consent/admin model. |
| Private ownership | User/conversation membership tables and RLS. | `owner_email` is the exact allowlisted DWD subject; memberships retain canonical IDs/display names because Chat `User` has no email. RLS requires matching verified requester identity. | Owner isolation parity; no participant-email claim. |
| Company projection | Channel/day, thread, attachment documents. | Shared-space thread and attachment documents; reaction/card text included. Owner-scoped DMs excluded. | Core parity; aggregation shapes differ. |
| Attachments | Metadata and optionally bounded bytes. | Official Chat attachment metadata and raw payload only; no arbitrary raw-byte retention. | Slack retains more content. |
| Source edits | Overlap/incremental refresh updates retained messages. | Scheduled full rescans refresh old edits. | Parity outcome with higher Google read cost. |
| Source deletions | Slack event/history paths reconcile retained deletions where supported. | Every app/delegated message scan requests the officially supported `showDeleted=true`; tombstones delete retained messages, attachments, and reactions. | Parity implemented locally; shared-space and DM live convergence remain unverified. The earlier app-auth limitation was incorrect. |
| Reactions | Stored/projected with Slack messages. | Dedicated message-qualified reaction table and projected thread context. | Parity. |
| Archive import | Slack export ZIP importer/API/Console. | None. | Accepted Slack platform advantage; Workspace/Vault export is a different product flow. |
| Retention | Count/dry-run/delete for shared/private corpora. | Count/dry-run/delete for documents, attachments, reactions, messages, finished checkpoints, empty spaces, and terminal runs. | Parity implemented. |
| Metrics | Run, API/rate-limit, backfill, lag, retention, archive. | Run/duration, API/rate-limit, items, failures, continuation age, watermark lag, last failure, retention. | Parity for operational signals. |
| RLS/readonly grants | Slack channel/private policies. | Shared space and owner-email policies across spaces/messages/attachments/reactions/checkpoints. | DB-backed owner isolation and the subject-aware DM broker pass; live ETL persisted nonzero owner-keyed messages, attachments, reactions, and checkpoints separately from shared rows. Cross-owner negative evidence remains pending. |

## 7. Reliability, deployment, observability, and tests

| Capability | Slack | Google Chat | Current difference |
| --- | --- | --- | --- |
| Chart default | Slackbot enabled. | Googlechatbot disabled until configured. | Deliberate deployment default. |
| Durable state | Required Postgres Chat SDK state. | Required Postgres Chat SDK state; memory adapter accepted only when explicitly injected by tests. | Parity. |
| Webhook ACK | Waits for durable handoff under Slack retry semantics. | Persists accepted work before returning Chat-required `{}`; background delivery follows. | Equivalent durable boundary under different platform contracts. |
| Multi-replica lease | Durable action/render leases. | Renewable per-thread work lease and durable action dedupe. | Parity implemented; live two-replica Kind lease/recovery check passes. |
| Crash recovery | Startup/index sweep, SSE replay, canonical delivery reconciliation. | Startup + recurring sweep, last-event resume, canonical update/replacement, stale age/failure budget. | Parity implemented; live processing-pod kill recovered exactly one final with no stranded thinking message. |
| API timeouts | Bounded Slack/control operations. | 30-second Chat/control fetch defaults, 10-second SSE connect timeout, long-lived established stream, reader cancel/release. | Parity. |
| Rate limits | Slack SDK/API paths apply their platform retry policies. | Shared StateAdapter reservations pace all same-space writes at 1/second and direct/aggregate reaction reads at 15/second across bot replicas; bounded 429 retry covers Google authority and other read categories. | Parity in quota-safe operation; live multi-replica Workspace load proof pending. |
| Readiness/liveness | State-aware readiness, process liveness. | `/health/ready`/`/health` depend on Postgres; `/health/live` is process-only; server waits before bind. | Parity. |
| Metrics | Broad bot and recovery families. | Events/runs/identity/session API/dedupe/recovery/timeouts/delivery plus state/SSE/obligation gauges. | Parity for required operations. |
| Prometheus wiring | Service annotations/probes. | Service annotations and distinct probes. | Parity; live Kind scrape passes. |
| Network policy | Restricted service topology. | api-rs-only internal bot ingress verified by rendered-manifest script. | Automated and live Kind enforcement pass. |
| CI | Typecheck and repeated Slack suites. | Typecheck/full suite, signed fixture smoke, CLI, Rust, Rails, workflow, Helm/schema, image-build, Argo, and production verification gates. | Release CI, CodeQL, 99 workflow tests, six image builds, strict 33/33 + 21/21 manifests, Argo health, and the 9/9 production verifier passed; TEST-031 remains pending for the uncompleted external scenarios. |
| Signed developer fixture | Slack signed request tooling. | `pnpm --filter googlechatbot run smoke` covers signed legacy/Add-ons mention, DM, group, stop, follow-up attachment, actions/commands/forms, duplicate, restart render, internal mutations/files/denial. | Parity in deterministic tooling. |
| Operator docs | Slack setup, ETL, permissioning. | Google Chat reference and ETL pages now cover scopes, DWD, permissions, files, recovery, smoke, rollback. | Documentation parity implemented; docs build passes. |

## 8. Accepted exclusions

The parity plan records two explicit constraints:

- **CON-001:** do not copy Slack's streaming API or presentation model into
  Google Chat. Use platform-native bounded status and canonical multipart final
  delivery.
- **CON-002:** do not add a global Workspace user directory. Use space
  membership and exact email DM targets without broad Admin SDK Directory
  scope.

Related Slack-only features—user groups, Slack Connect delayed-file repair,
Slack export ZIPs, and Slack channel-title/public/private semantics—remain
platform differences, not Google defects.

## 9. Verification still required

Automated checks and the production Workspace exercise the implementation. The
following external gates still block an exhaustive parity claim:

1. Real Google-signed project-number or endpoint-URL ingress, followed by live
   legacy message/mention/self/bot checks and Add-ons action/command/form payloads.
   The authentic DWD-authored message test produced no observable webhook, so
   the Chat API connection/authentication-audience setting must be corrected in
   Google Cloud Console first.
2. File boundaries at 25 MiB, 25 MiB + 1, 100 MiB, and 100 MiB + 1 with staged
   reconstruction and SHA-256 verification.
3. Actual narrow/wide keyboard-only Console grant workflows with screenshots.
4. Explicit live ETL continuation, cross-owner negative RLS, rate-limit/
   permission recovery, and retention scenarios.
5. Live shared-space and delegated-DM deletion convergence using
   `showDeleted=true`, plus reaction-removal convergence and derived-row cleanup.
6. The remaining Google-native Drive export types and above-10-MB error path;
   the live XLSX below-limit path passed.
7. The complete TEST-031 matrix passing on the same immutable release evidence
   as every TEST-001 through TEST-030 row.

## Bottom line

The production release implements most required Google Chat outcomes without
copying Slack-only abstractions. DWD setup/history, mutations, reactions,
uploaded files, Drive XLSX export, and owner-scoped ETL are now live-proven.
The remaining work is narrower release evidence: Google-signed inbound after
the external Console fix, the listed size/deletion/removal/negative scenarios,
and the final same-immutable-evidence quality gate. Slack remains the fully
production-proven reference until those gates pass.

Google Chat retains two useful platform differences: scoped generic
update/delete for app-owned messages and a bounded status/final response UX.
Its stricter proxy-only agent topology and independently revocable DWD subjects
also make the effective permission boundary easier to audit than the original
direct-credential design.
