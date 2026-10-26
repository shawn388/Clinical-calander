# Staging and cutover procedure

No step in this runbook has been applied to production. Implementation approval covered the isolated branch and local tests. Deployment, production data writes, trigger changes, real test messages, and merging require separate authorization.

## Preserve the current system

1. Export the complete production workbook, both Apps Script files, the hidden manifest, Script Properties configuration with secrets kept separately, and all owner trigger inventories. The existing bounded review snapshots are evidence, not a complete recovery backup.
2. Record the reviewed baseline commit `d831c0640f769ac986b3b02242570d627a50d557`, Render service/deployment identifiers, build/start commands, timezone and existing recipients. Confirm the live SHA again at cutover.
3. Keep raw PDFs and roster snapshots outside the public repository. Preserve the legacy `Clinical_Log`, `Manual_Email_Queue`, `Parse_Metrics` and archive. The repaired code writes new `RR_V2_*` tabs and a separate archive folder.

## Prepare an isolated staging environment

Create a test workbook from an authorized copy, a separate Apps Script project, a separate archive folder, and an independently deployed parser only after the applicable deployment approval. Install **all three** `.gs` files and the supplied manifest in the test project. Do not run any old production diagnostic or force-dispatch function.

Use Python 3.12.14 and the checked-in requirements/constraints. Render supports `.python-version`; an existing `PYTHON_VERSION` environment variable takes precedence, so inspect it before relying on the repository pin. See [Render Python version configuration](https://render.com/docs/python-version).

The parser needs `PARSER_API_TOKEN`; set its matching value in Apps Script without placing it in source control or logs. Use `pip install -r requirements.txt` and `gunicorn main:app --timeout 120`. Verify the Linux staging runtime and resource behavior; local tests ran on macOS. Confirm `/health` reports the intended commit and parser version, then exercise authenticated uploads in staging. The production free-instance cold-start risk remains until staging validates the operational configuration or the owner approves a different service plan.

Apps Script properties:

| Property | Staging value |
| --- | --- |
| `RUN_MODE` | `TEST` |
| `SPREADSHEET_ID` | Explicit test workbook ID, different from production |
| `PRODUCTION_SPREADSHEET_ID` | Actual production workbook ID, used only to reject it in TEST mode |
| `OWNER_EMAIL` | Verified owner address, kept in private configuration |
| `NOTIFICATION_TO` | Comma-separated verified scheduling recipients, kept in private configuration |
| `PARSER_URL` | Separate staging HTTPS `/parse-calendar` URL |
| `PARSER_API_TOKEN` | Matching parser token |
| `ARCHIVE_FOLDER_ID` | Separate authorized test archive folder |
| `NOTIFICATIONS_FROM` | Explicit ISO cutover/simulation timestamp |
| `LIVE_EMAIL` | `false` |

Set both script and workbook timezone to `America/New_York`. The code refuses the production workbook or live delivery in TEST mode. Do not override these guards to test production.

## Migration rehearsal

1. Run `stageClinicalLegacyHistory()` **before the first ingestion**. It copies raw legacy log/queue rows into the v2 state and does not modify those legacy tabs. Legacy `SENT`/log records retain their recorded status; pending/approved queue rows do not become verified shifts or accepted messages. Unparseable dates and ambiguous legacy records go to review.
2. Run `ingestClinicalCalendars()`. Review `RR_V2_Students` and assign verified immutable `Student ID` values to the test roster where necessary. The registry bootstraps deterministic IDs from normalized name/cohort/email. Moving a record to Archive preserves that identity; a later email change without an explicit ID is held for identity review. Duplicate active/archive identities remain ambiguous.
3. Inspect sources, extracted records, reviews, prior/current shifts, notification previews and the calendar. A source with unresolved identities is held as a whole; confident observations remain preserved for review, and prior current shifts remain intact.
4. Reprocess after corrections. In `RR_V2_Actions`, use source ID + `REPROCESS_SOURCE` with evidence to request re-evaluation of an already applied source. A REVIEW/FAILED source is retried by ordinary ingestion. Aliases and review actions are described below.
5. Run `dispatchClinicalNotifications()` with live email disabled. It creates previews only. Run `checkClinicalHealth()` to inspect owner alert and summary previews. Confirm actual times, To recipients, student CC, coverage, corrections and all relevant months.
6. Simulate duplicate runs, parser failures, invalid JSON, missing attachments, locks and interruption during persistence/sending. Reconcile every discrepancy and verify exception links. The checked-in mocks already exercise these paths, but a real Google staging integration remains a release gate.

## Review actions

`RR_V2_Reviews` is a regenerated view. Put decisions in `RR_V2_Actions`, whose columns are Record ID, Action, Evidence/resolution, Processed at, and Student ID. Leave Processed at blank for new actions; the processor fills it after committing. Execute `applyClinicalReviewActions()` in the authorized environment.

- `APPROVE_ALIAS`: use a name-match review ID and the verified unique Student ID. Evidence must describe the identity verification. This creates an auditable alias; it does not infer an identity. Re-run ingestion to validate the source afterward.
- `RESOLVE_REVIEW`: use a review ID with resolution evidence. Resolving a review alone never activates an incomplete source or an uncertain send.
- `REPROCESS_SOURCE`: use a source ID with the reason for re-evaluation.
- `CONFIRM_ACCEPTED`: use an UNCERTAIN or LEGACY_REVIEW notification event ID and concrete Sent-message evidence. This marks acceptance with manual evidence, not recipient delivery.
- `CONFIRM_NOT_SENT`: use such an event ID only after confirming no message was accepted; it releases the event for retry. Inspect Sent mail and draft state first.

Many-to-many reschedules and conflicting equal-publication PDFs remain held. Correct the authoritative source or provide a reviewed migration mapping; there is no button that guesses these relationships. Historical raw rows stay preserved.

## Production authorization package

Present the final commit/diff, local test report, staging results, complete migration preview, archived/unmatched decisions, actual payload previews, parser resource plan, trigger inventory and rollback export. Agree on timing tolerance: the implementation uses 24 elapsed hours and proposes a five-minute due-work dispatcher. Apps Script timers and contention do not guarantee exact-to-the-second delivery; a skipped lock acquisition waits for the next execution.

For an authorized cutover:

1. Pause the old processing/sending trigger and preserve its configuration. Ensure no old or emergency dispatcher can send concurrently. Remove the obsolete emergency force-dispatch file from the active supported project after preserving its source.
2. Install the tested parser and token configuration and verify its commit. Install the complete Apps Script package, set production IDs deliberately, `RUN_MODE=PRODUCTION`, `PRODUCTION_CUTOVER_APPROVED=true`, and `LIVE_EMAIL=false`.
3. Stage historical records before ingestion, verify stable IDs, set `NOTIFICATIONS_FROM` to the approved cutover boundary, ingest and compare previews. Legacy send identities that lack time/version evidence must be resolved before any resend.
4. Install the explicitly approved triggers: proposed hourly ingestion, every-five-minute dispatcher, and a daily health/summary job. Set uncaught-trigger failure notifications to immediate. No trigger installer is included or executed automatically.
5. Obtain authorization for each intended real test email/recipient set. After successful staging and the approved live test, enable `LIVE_EMAIL=true`. Confirm API acceptance, persisted attempt/message IDs and owner visibility. Do not claim recipient delivery from the send result.
6. Observe schedule changes, retries and exception queues before considering rollout complete. The public GitHub branch must not be merged casually: Render auto-deploys production main.

## Rollback

Disable new dispatch claims first. Export the **current** ledger head, both chunk banks, review actions, registry, projections and all accepted/uncertain event IDs. Preserve the content-addressed PDF archive. Never erase notification history to restore a prior code version.

The ledger stores complete state in alternating `RR_V2_Chunks_A`/`B` banks. `RR_V2_Head!A2:D2` identifies the committed digest, bank, first row and count. A failed write to the inactive bank leaves the current bank authoritative. Only restore a previous head after checksum verification and reconciling every send since that snapshot; otherwise an accepted event could be sent again. Both banks retain all logical history in their snapshots, but they are not a substitute for external backups.

Restore the last approved compatible parser/Apps Script revision and configuration with live email disabled, validate the current ledger, and reconcile uncertain sends. The original baseline is known to miss shifts and cannot honor the new durable identities. Do not resume its dispatcher against v2 history. Keep delivery disabled or use an explicitly approved manual continuity process until an operationally safe revision is ready.

If the Sheets ledger is unavailable, inspect `RR_FATAL_*` Script Properties and the owner failure notification. An uncertain fallback alert is also held instead of automatically resent. After resolution, retain the failure evidence and mark/reset the property only as an explicit owner action.
