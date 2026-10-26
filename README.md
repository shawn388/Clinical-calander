# Ricky Rescue clinical scheduling

This branch replaces the calendar string-slicing parser and the coupled Apps Script workflow with structured PDF extraction, an auditable schedule ledger, and independent notification jobs. It is prepared for isolated staging. Production installation and live delivery require separate owner authorization.

## Files

| File | Purpose |
| --- | --- |
| `calendar_parser.py` | PDF word coordinates, calendar/date validation, event ownership, student-shift objects, completeness checks |
| `main.py` | Authenticated Flask API with typed errors and upload limits |
| `apps_script/Engine.gs` | Pure matching, version authority, reconciliation, notifications and exception logic |
| `apps_script/Ledger.gs` | Durable Sheets state snapshots and readable review/schedule projections |
| `apps_script/Code.gs` | Gmail, Drive, Sheets and scheduling adapters; migration and review actions |
| `tests/` | Synthetic PDF, core, adapter, concurrency and persistence regression tests |
| `scripts/` | Optional offline evaluation using private review fixtures |
| `docs/DEPLOYMENT.md` | Staging, migration, cutover and rollback procedure |
| `docs/IMPLEMENTATION.md` | Results, data model, design decisions and operational limits |

The prior production Apps Script is preserved outside this checkout in the local review evidence. This checkout contains no historical PDF, roster, API key, or email attachment. Keep private fixtures and outputs in ignored `private/` directories.

## Local verification

Python is pinned to 3.12.14. Dependencies are constrained to the versions used in verification. The synthetic suite runs without Google credentials and generates its own PDFs.

```sh
python -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.cjs
```

Private-fixture tests skip when the local review inputs are absent. The public suite never downloads student data. The GitHub Actions workflow is provided but has not been executed remotely as part of this local implementation.

For the supplied local review inputs:

```sh
.venv/bin/python scripts/benchmark.py ../review/evidence private/results
TZ=America/New_York node scripts/replay_private.cjs ../review/evidence private/results
```

The benchmark expects `verified-corpus.json`, original PDFs, bounded roster snapshots, baseline parser grids and the separately preserved Apps Script baseline. Ground truth must be established by a person reading the PDFs; do not generate expected results from the parser under test.

## API

`GET /health` returns build commit and parser version. `POST /parse-calendar` accepts multipart field `file` and requires `Authorization: Bearer <PARSER_API_TOKEN>`. An unconfigured token disables parsing with HTTP 503. `ALLOW_UNAUTHENTICATED=true` is an explicit local-development escape hatch; do not enable it on a hosted service.

Responses use schema version 2:

- `source_sha256`, `generated_at`, `parser_version`, `page_count` identify the source and parser.
- `shifts` contains ISO dates, printed start/end times, offset-aware instants, timezone, raw student names, location, page, bounding boxes, raw text and original word coordinates.
- `coverage` lists validated printed date windows for each page/site. The filename is checked against printed months; its month range does not stand in for exact coverage.
- `coverage_complete`, `status`, `errors` and `unresolved_blocks` control whether reconciliation is permitted.
- `grid_rows` is retained as a geometry-based compatibility view. The repaired Apps Script consumes structured shifts.

Complete supported calendars return 200, review-required/invalid PDFs return 422, missing uploads return 400, oversized uploads return 413, and unexpected failures return JSON 500. Authentication failures return 401. Limits are 8 MiB and ten pages. A validated empty calendar can be complete; a blank, scanned, cropped or unsupported calendar is not assumed empty.

## Behavior

Roster reads use explicit headers. Matching accepts a unique normalized full name, a controlled reversed name, or an explicitly approved alias to one Student ID. It does not accept shared first-name tokens. Active and archived records remain distinct; archived matches produce owner flags. Missing names, duplicate identities, invalid emails and malformed roster rows create reviews.

Sources retain message/attachment identity, content hash and printed publication time. Older calendars cannot overwrite newer covered dates, including dates newer calendars show empty. Equal-publication conflicting content requires review. Incomplete imports and imports with unresolved identities preserve the prior schedule. Dates outside a rolling window are not cancelled.

One-to-one changes for a student/site retain a shift ID and produce reschedule history. Exact student/start/end evidence can also link a verified site cancellation/addition published on the same day. Ambiguous many-to-many changes require review. Previously notified changes generate correction events with prior and current details.

Notifications are due 24 **elapsed hours** before the shift. This deliberately handles daylight-saving offsets; it can differ from the same local clock time on the previous day. A configurable cutover timestamp suppresses historical backfill. Already-started unsent shifts are surfaced as missed notifications. Due upcoming shifts discovered late are eligible immediately.

Sending has durable PREPARING/SENDING/API_ACCEPTED states, with a script-wide lock. Draft-creation failures retry with backoff. Unknown send outcomes remain UNCERTAIN; the next run searches Sent evidence rather than blindly resending. API acceptance is never labelled recipient delivery. Test mode never creates a draft or sends email.

Owner exception events include category, student/PDF identifier, affected date, reason, review-row link and resolution instructions. Recurring open issues deduplicate; the health job prepares a daily unresolved summary. The independent watchdog can deliver owner alerts without sending student notices. A small Script Properties failure ledger covers failures of the Sheets ledger itself.

See the deployment runbook before installing any `.gs` files, configuring properties, or creating triggers.
