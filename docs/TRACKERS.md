# Trackers — the forms platform

Lookie-Link's second pillar. Files render documents; **Trackers** capture them:
small structured forms whose submissions accumulate into permanent, auditable
logs. A tracker is a form you return to — a gym machine, a medication log, a
weight check — and everything distinctive about the platform happens *after*
submission.

Enable it with the `forms:` block in the config (see
[CONFIGURATION.md](CONFIGURATION.md) and the annotated
`lookie-link.yaml.example`). Everything below assumes it is enabled.

## Four kinds (internal taxonomy)

Internally the platform has four kinds of template — the labels below are
for builders and this doc, not end-user marketing:

- **TRACKER** (`kind: 'form'`) — logs. Entry form, history, receipts.
- **LIST** (`kind: 'list'`) — checklist. Mutable current state (sections and
  items with checkboxes). No submissions and no receipts; state lives in
  `list-state.json` beside the draft and uses revision CAS. A missing state
  file reads as virtual revision `0` and is created only on the first
  authorized write.
- **PARENT** (`kind: 'parent'`, or any form something inherits from) —
  defines. Its fields serve on its children live; it never accepts new
  entries itself (a born parent refuses everything and carries no entry
  storage; an emergent parent — a form that gained children — keeps its
  legacy history readable and correctable but takes no new entries). Its
  page lists its children.
- **GROUP** (`kind: 'container'`) — holds. Navigation, membership, theme
  defaults, aggregated history. Same lifecycle and versioning as everything
  else.

## Two-plane language

End-user surfaces say **tracker** and **group**. The API and the storage say
**form template**, **kind: 'container'**, and keep every URL under `/forms/…`.
This split is deliberate: the plumbing never churns when the language does.

**The visible builder is an end-user surface.** Its chrome — headings, buttons,
select options, help text — says *tracker*, because what you are creating is a
tracker. The system words stay in the API, the stored documents and this
document. A page that shows a person the word *template* is leaking its
plumbing.

Help text is also written for the person reading it, never for a reviewer:
no internal issue numbers in visible copy. If provenance is worth keeping, it
belongs in a code comment beside the string.

## Core guarantees

These invariants hold everywhere and explain most design decisions:

1. **Submissions are immutable.** There is no edit. A correction is a new
   submission that names its predecessor (`supersedes`); the original remains,
   and receipts show the full chain. History is audit-grade by construction.
2. **Receipts capture the moment.** Every submission snapshots the field
   labels, types, and options *as they were at capture time*. Schema changes
   never rewrite history — a renamed option or deleted field cannot alter what
   an old receipt says.
3. **Authors select aliases, never paths.** A template names a
   `destinationId` and a `theme` from deployment-approved lists. There is no
   way to enter a filesystem path or an arbitrary style through the builder or
   the API — unknown aliases are refused, not defaulted (fail-closed). This is
   what keeps a template-authoring UI from becoming an arbitrary-write
   primitive.
4. **The draft is live; versions are frozen snapshots.** Templates use
   compare-and-set revisions (stale writes are rejected with a conflict).
   The served form is always the current draft, so a saved revision is live
   at once; publishing freezes an immutable numbered snapshot you can view
   and restore later. Removed fields are retained and marked `isDestroyed`
   rather than deleted, so old data always has a schema identity to resolve
   against.

## Templates and lifecycle

A template is a JSON document (`kind: 'form'` by default) with identity
(`templateId`, `title`), a `destinationId` alias, optional `presentation`
(theme, theme mode, submit label), optional structure (`containerId`,
`parentId`, `related`, `tags`), and `fields`.

Lifecycle: **create draft → revise (CAS on `revision`) → publish** (freezes a
`form-template-version` document carrying the schema digest and the structural
keys) → optionally **archive** (reversible; archived templates stop accepting
entries but keep serving history and receipts) or **clone**.

**There is no private staging draft.** The entry page, previews and
`POST /api/forms/:id/submissions` all serve the current draft (resolved
through its parent for a child). A `PATCH` or a Configure save is live for the
next entry, and each stored record's `templateVersion` is the draft
`revision` it was captured against. A tracker that has never been published
(`state: 'draft'`) still takes entries. Publishing does not ship anything: it
freezes a restorable snapshot. Configure can open a published version
read-only (`?version=N`) and restore it into the draft as a new revision, and
clone accepts a `templateVersion` to copy from. So patch only what you mean
to ship, and publish when you want a point you can return to.

Field types: `short-text`, `long-text`, `number`, `checkbox`, `date`, `time`,
`datetime`, `select`, `multi-select`. Selects carry options with stable ids;
number fields support min/max/step; any field can set `default`, `required`,
`help`, and `showInList` (which values headline history rows).

### Conditional fields (`showWhen`)

A field can be shown only while a select or multi-select field holds given
options:

```json
{"id": "club", "type": "select", "label": "Club", "required": false,
 "options": [{"id": "downtown", "label": "Downtown"}],
 "showWhen": {"fieldId": "scale", "optionIds": ["gym"]}}
```

- **Validation.** `fieldId` must name another field in the template that is a
  `select` or `multi-select` with declared `options` (not a `providerSlot`),
  every `optionIds` entry must be one of its option ids, and conditions must not
  form a cycle. A child form may name an inherited parent field; that reference
  resolves at serve time.
- **Meaning.** The field is visible when its target is itself visible and the
  target's submitted value is one of `optionIds` (for a multi-select, any
  selected option counts). Values are what was submitted: defaults are not
  applied, so an API caller that omits the target hides the field.
- **Hidden fields.** A hidden field is never required, and any value submitted
  for it is dropped before the entry is stored, on the native form and the JSON
  API alike. A stored entry therefore never contradicts its own condition.
- **In the browser.** The form, inline corrections and history editors hide and
  disable a conditional field while its condition is false. Without script the
  field stays visible and the server still drops a hidden value. A required
  conditional field is marked required only while shown, so a browser without
  script can still submit when it does not apply.
- **Builder.** Each field's settings have a **Show this field** select listing
  `Always` and every option of the template's selection fields. A condition with
  several options (set through the API) is kept and shown as one choice.
- **Drift.** When a draft is saved, its conditions must resolve. Removing an
  option a condition names, deleting its target, or changing the target's type
  is refused until the condition is changed. Archiving the target
  (`isDestroyed`) is allowed and leaves the field always visible. At submit
  time a condition that no longer resolves (for example, a parent edit that
  drops an option a child's condition names) also leaves the field visible
  rather than refusing entries.
- **History.** Stored entries are never rewritten. A correction is a new
  submission, so it applies the current conditions: correcting an old entry
  drops a value whose condition is now false.

## Groups (containers)

A group is a template of `kind: 'container'` — same registry, same lifecycle,
same Configure surface, but no fields and no destination. Membership lives on
the members: a form template's `containerId` names its group (fail-closed to
an existing, unarchived container).

What a group gives you:

- **Its page is a hub**: tap-in rows for each member (with an expandable live
  preview of the member's fields), the member's name linking straight to a new
  entry.
- **Aggregated history**: the group's History view merges its members'
  entries newest-first, each row tagged with the member it came from.
- **Scoped management**: creating a tracker from a group's page pre-joins it;
  the group's archived members are listed (and restorable) on the group's own
  page; member Configure links sit in each row.
- **Theme fallback**: a member with no theme of its own renders in its
  group's theme on view surfaces. (Configure always reports only what is
  actually saved.)

Groups are single-level: containers cannot nest.

## Parent/child inheritance

A form template may declare `parentId` naming another form template. The child
then **inherits the parent's schema live**:

- **Resolution happens at serve time.** The rendered form, submissions,
  previews, and digests use: the parent's fields, with any child field whose
  `id` matches a parent field **overriding it in place**, and the child's
  other fields **appended** after. Edit the parent once and every child
  updates instantly — no regeneration, no sync step.
- **Overriding = redefining by id.** To narrow a select to one option (the
  per-machine pattern), a child carries a single field with the parent field's
  id and the narrowed options/default. A child may carry zero fields (pure
  inheritance).
- **The child's stored document stays thin.** The management API returns the
  child's own fields as `template.fields` (what the builder edits) and the
  served schema as `resolvedFields`, with `resolvedSchemaDigest` computed
  from the *resolved* schema — so the digest honestly changes when the parent
  changes.
- **Guards** (all fail-closed): the parent must exist, be unarchived,
  form-kind, and itself parentless (single level); self-reference is refused;
  archiving a parent with active children is refused until they are detached
  or archived.
- **Detaching** (`parentId: null`) materializes the resolved fields onto the
  child, so nothing it served ever disappears.
- **Receipts are already safe.** Capture-time snapshots mean parent edits
  never rewrite what an old receipt shows — inheritance rides the same
  guarantee as everything else.
- **Dedup rule**: with a parent set, removing an own field whose id the
  parent defines is deduplication, not deletion (the field survives in the
  resolved schema), so a full copy can be slimmed down to just its overrides.
- **Per-child selection** (`inherit: {exclude: [fieldId…]}`): an inherited
  field can be left off one child without touching the parent or its
  siblings. The child's Configure shows every inherited field with a
  checkbox (uncheck = exclude) and an **Override** button that copies the
  parent's definition into the child's own fields for editing. Detaching
  honors exclusions in the materialized fields, then clears the config.
- **Theme inheritance**: on view surfaces, a tracker with no theme of its own
  resolves **own → parent → group → viewer**, for both the color scheme and
  dark/light mode.

Inheritance and grouping are orthogonal: the canonical pattern is a master
template that is the parent of many children which all share one group (e.g. a
gym master parenting one child per machine, every child in the Gym group).

## Related trackers (the strip)

Every tracker page and receipt ends with a navigation strip: a back-link to
its group plus related trackers. What rides the strip is configurable per
template via `related`:

```json
{ "group": true, "include": ["weight", "health"] }
```

- Absent (the default): the whole group rides the strip.
- `group: false`: drop the siblings; only explicit picks ride.
- `include`: extra trackers from *any* group — and an id naming a **group**
  includes that whole group live (new members follow automatically).
- Include entries are soft references: the strip renders only what exists, is
  active, and the viewer may see. A deleted tracker can never break a page.
- The strip is one alphabetical run by title. Group members and cross-group
  picks sort together rather than in separate blocks, and the group's
  `memberOrder` does not pin anything here — the strip is an index, so the eye
  should be able to start from the letter.

Configure exposes this as the "Related trackers" disclosure above Save draft:
each group is a checkbox row (your own group's box is the all-in-group flag),
expandable to individual trackers.

## Themes and destinations

Both are **deployment-owned alias lists**. Destinations map ids to storage
roots in the config; themes are installed server-side (built-in or via the
config's `themes:` block). Templates select by id; unknown ids are refused at
save time. A tracker with no theme follows the viewer's theme, unless its
group provides one (see fallback above).

## Navigation model

One rule: **every bar starts with its parent.**

- The root (`/forms`) **is called Trackers** — it renders the whole hierarchy,
  every tracker nested under its group, with archived *groups* collapsed at the
  bottom. Everything that links back to it says `Trackers`; nothing says
  "Groups".
- The root family — the root, its history, and the unscoped create pages —
  all carry one bar: `Trackers | History | New tracker | New group`, with the
  current page lit and the two create links present only for a viewer who can
  create. Being at the root, it has no up-link.
- A group's bar: `← Trackers | Trackers | History | Configure | New tracker | New group`.
- A tracker's bar: `← Trackers | Log an entry | History | Configure`.
- A create page scoped to a group (`/forms/new?group=<id>`) carries that
  group's bar instead, so the way you arrived stays on screen.
- A receipt carries its tracker's bar, with nothing marked current — a receipt
  is none of the four views the bar lists. Without it, submitting an entry
  dead-ends: the in-card actions all lead back into the same tracker.
- The bars are sticky (pinned under the viewer toolbar) and persist into the
  create pages, so there are no dead ends.

**Ordering: an index and a sequence want different orders.** A group's
`memberOrder` curates its hub page, where the order is the sequence you work
through — circuit order beats the alphabet there. Every listing that is a
*lookup* rather than a sequence sorts by title instead: the related strip and
a parent's list of children. Ask which one a surface is before choosing its
order, and prefer the alphabet when unsure — a listing that is sorted except
for one pinned row reads as sorted, so a reader trusts it and then cannot find
the row they came for.
- The toolbar stays contextual, per the Files idiom: core switches (Files /
  Trackers, theme) always; Properties appears on trackers *and* groups; all
  toolbar disclosures are mutually exclusive.

## API quick reference

All under `/api/forms`, JSON. Browser mutations require the CSRF envelope
(context cookie + `_csrf` token from a served form page + an allowed
`Origin`). Bearer callers skip it; see
[Agents: CLI and bearer access](#agents-cli-and-bearer-access) and
[AGENT-ACCESS-CONTROL.md](AGENT-ACCESS-CONTROL.md) for the access model.

| Operation | Route |
|---|---|
| List templates | `GET /api/forms/templates` |
| Read one (draft + `resolvedFields` for children) | `GET /api/forms/templates/:id` |
| Serving fields + option ids (submitters too) | `GET /api/forms/:id/fields` |
| Create draft | `POST /api/forms/templates` |
| Revise draft (CAS: send `revision`) | `PATCH /api/forms/templates/:id` |
| Publish | `POST /api/forms/templates/:id/publish` |
| Archive / restore | `POST /api/forms/templates/:id/archive` · `/restore` |
| Clone | `POST /api/forms/templates/:id/clone` |
| Submit an entry | `POST /api/forms/:id/submissions` |
| Read submissions | `GET /api/forms/:id/submissions` |
| Correction chain | `GET /api/forms/:id/submissions/:submissionId/history` |
| Read list state | `GET /api/forms/:id/list` |
| Replace list state (CAS) | `PUT /api/forms/:id/list` |
| Validate list state | `POST /api/forms/:id/list/validate` |

### Submitting an entry as JSON

`POST /api/forms/:id/submissions` runs the same submission service as the
entry page. The body, what the server fills in (pinned selects, event time),
and the errors are in the [agent quickstart](#agent-quickstart), which is the
one place that contract is written down.

Template keys accepted on create/patch include the structural set —
`kind`, `containerId`, `memberOrder`, `parentId`, `related`, `inherit` —
everything the GUI can do, the API can do.

## Agents: CLI and bearer access

An agent logs or changes trackers with a bearer credential that carries forms
capabilities: `formsCapabilities: [forms.submit]` to log entries, plus
`forms.manage` to edit trackers. Set it on a static token in `access.tokens`
(with `subject.agentId`) or when creating a managed API key. A grant covers
every tracker on the instance. Check it with `lookie whoami`
(`formsCapabilities`).

| Task | Command |
|---|---|
| Find the tracker | `lookie forms list` |
| Field and option ids (child trackers show resolved fields) | `lookie forms show <id>` |
| Log an entry now | `lookie forms submit <id> --value reading=12` |
| Log a past entry | `lookie forms submit <id> --at 2026-11-18T09:30 --tz America/New_York --value …` |
| Log from a file | `lookie forms submit <id> --values-file entry.json` (or `-` for stdin) |
| Check before sending | add `--dry-run` |
| Verify | `lookie forms submissions <id> --limit 5` |
| Correct an entry | `lookie forms submit <id> --supersedes <submissionId> --value reading=13` |
| See a correction chain | `lookie forms history <id> <submissionId>` |
| Change the tracker (serves at once) | `lookie forms patch <id> --revision N --body-file patch.json` |
| Freeze a version | `lookie forms publish <id> --revision N` |

What `forms submit` does for you:

- Nests values under `values` and coerces `--value` strings by field type.
  Numbers become numbers. Checkboxes take `true`/`false`. A select takes an
  option id or its unique label. A multi-select takes a comma list or a JSON
  array.
- Computes `eventAt`, `timezone`, and `clientOffsetMinutes` from `--at`, or
  from now when `--at` is absent. `--at` is RFC 3339 or a wall time read in
  `--tz`. `--tz` defaults to `LOOKIE_LINK_TIMEZONE`, then the host zone. The
  offset is the zone's offset at that instant: `-300` for EST, `-240` for EDT.
  A wall time the clocks skip (spring forward) is refused. A repeated one
  (fall back) takes the earlier instant; give an explicit offset for the
  later one. Impossible dates such as Feb 30 are refused, never rolled over.
- Fills defaults and the datetime explicitly. The server fills pinned selects
  and derives `eventAt`; the CLI fills defaults and the datetime explicitly.
  It sends every declared `default` you omit (the server applies none) and
  sets an empty datetime field to `eventAt`. It always sends the full time
  trio, so nothing depends on server inference. Without `--at`, a single
  datetime value you supply becomes `eventAt`.
- `--supersedes` starts from the corrected entry's values and `eventAt`, sends
  `supersedesRecord: {id, resourceKind: 'form-submission'}`, and refuses (exit
  `5`) when the entry is already superseded. Correct the latest entry instead.
  Old entries are never edited.
- `--idempotency-key` makes a retry safe. It needs a fixed time (`--at` or a
  datetime value), because "now" changes between runs and a changed body is
  `409 idempotency_conflict`, not the original receipt.

A `422` names the failing path, for example `values.reading: is required`.

## Agent quickstart

How an agent logs, corrects and verifies an entry through the JSON API.
These are the plain HTTP calls behind `lookie forms`
([above](#agents-cli-and-bearer-access)); prefer the CLI where it runs.
Who fills what: the server fills pinned selects and derives eventAt; the CLI
fills defaults and the datetime explicitly.

### 1. Discover the field ids

Set `$HOST` to the deployment base URL and `$ID` to the tracker id.
`GET /api/forms/$ID/fields` returns the serving fields (a child's resolved
fields) to any caller with `forms.submit` or `forms.view`, which is
`lookie forms show $ID`. Send the bearer without a context cookie.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/forms/$ID/fields" \
  | jq '.fields[]
        | {id, type, required, default, options: [.options[]? | select(.disabled != true) | .id]}'
```

Managers can also read `GET /api/forms/templates/$ID` (draft, revision and
versions). For a child, use its `resolvedFields` (what is actually served),
not `template.fields` (the child's own overrides).

### 2. Choose an envelope

Mutations take **one** of two credentials, never both (a bearer together with
the context cookie is `400 Ambiguous credentials`):

- **Bearer** — `Authorization: Bearer <token>`. No cookie, no CSRF token, no
  `Origin` requirement. Prefer this. The agent's static token or API key
  needs `formsCapabilities` including `forms.submit`; check
  `formsCapabilities` in `GET /api/whoami`.
- **Browser context** — for a caller that acts as a browser would:
  1. `GET /forms/<id>` with a cookie jar. The response sets the
     `lookie_forms_context` cookie and the page carries the synchronizer token
     in its `<input type="hidden" name="_csrf">`.
  2. `POST` with that cookie, `X-CSRF-Token: <token>`, and an `Origin` header
     matching a configured `forms.publicOrigins` entry.
  3. Never put `_csrf` in the JSON body: the body is an allowlist (below), so
     it is refused as a shape error. Use a fresh context per mutation when in
     doubt; a stale context is refused.

Every JSON request needs `Content-Type: application/json` (otherwise `415`).

### 3. Build the body

```json
{
  "values": {
    "session-date": "2026-11-18T09:20:00-05:00",
    "machine": "leg-press",
    "weight-lbs": 150,
    "sets": 3,
    "reps": 12
  },
  "eventAt": "2026-11-18T09:20:00-05:00",
  "timezone": "America/New_York",
  "clientOffsetMinutes": -300,
  "idempotencyKey": "leg-press-2026-11-18T09:20"
}
```

- **Top-level keys are an allowlist:** `values`, `eventAt`, `timezone`,
  `clientOffsetMinutes`, `idempotencyKey`, `supersedesRecord`. Anything else —
  flat field names, `_csrf`, `templateVersion`, `actor` — is
  `400 Unknown or server-derived submission field.`
- **`values` is an object keyed by field id.** A `select` takes one option
  id, a `multi-select` an array of option ids, a `number` a JSON number, a
  `checkbox` a boolean.
- **The server fills pinned selects and derives eventAt; the CLI fills
  defaults and the datetime explicitly.** General field defaults are not
  applied on the JSON path, so send required answers explicitly
  (`lookie forms submit` sends each omitted field's declared `default` and
  sets an empty datetime field to `eventAt`). A default is a suggested answer: send it only when it
  accurately represents this entry. A pinned select is the exception: exactly
  one enabled option makes it a fixed stamp, and when its key is missing from
  `values` the server records that option, whether the field is required or
  optional. Disabled options do not count. A supplied value is validated
  rather than replaced, so `null` or `""` for a pinned select is
  `422 validation_error`.
- **Datetime values carry an explicit offset.** `2026-11-18T09:20:00-05:00`,
  `…Z`, or minute precision `2026-11-18T09:20-05:00` (stored as
  `2026-11-18T09:20:00-05:00`). A value without an offset is
  `422 validation_error`; the server does not guess a zone.
- **Supply the time trio together, or let JSON derive it.** When all three of
  `eventAt` / `timezone` / `clientOffsetMinutes` are absent, the first active
  datetime field in field order with an explicit-offset value supplies the
  event time. The server uses its configured forms timezone when its offset
  agrees at that instant, otherwise `UTC` or a whole-hour `Etc/GMT` zone. If
  no matching zone is available (for example `+05:30` when the server zone is
  not on that offset), `eventAt` remains absent and the displayed time falls
  back to `receiptAt`; send an explicit trio to preserve the intended event
  time. An explicit trio fills a datetime value whose key is missing only when
  exactly one active datetime field exists. It does not overwrite a supplied
  datetime value. The three must agree:
  - `eventAt` is RFC 3339 with an explicit offset;
  - `timezone` is an IANA zone name;
  - `clientOffsetMinutes` is the offset of `eventAt` in minutes **east of UTC**
    (`-300` for UTC−05:00, `+60` for UTC+01:00). That is the opposite sign of
    JavaScript's `Date#getTimezoneOffset()`, so never pass that value through.
  Supplying only some of the three is `422`; offsets that disagree are `400`.
- **`idempotencyKey`** (1–128 visible ASCII characters) identifies one
  intended submission for this actor and tracker. A nonempty
  `Idempotency-Key` header takes precedence over the body key. Reusing the key returns the
  original record only when the normalized captured submission is identical
  (a body that differs only by values the server fills in counts as
  identical); otherwise it returns `409 idempotency_conflict`. A live schema
  revision can change that captured submission even with an unchanged HTTP
  body. After a conflict, check existing records before choosing a new key.
  Use a fresh key for a correction.

### 4. Correct an entry

Submissions are never edited. Send a new, complete submission naming its
predecessor:

```json
{ "values": { "...": "..." }, "eventAt": "...", "timezone": "...", "clientOffsetMinutes": -300,
  "supersedesRecord": { "id": "<submissionId>", "resourceKind": "form-submission" } }
```

`supersedesRecord` is an object, not a string: a bare id string, or an id
from another tracker, returns `404 Not found` (the predecessor is not
resolved). A record can be superseded
once (a second correction of the same predecessor is
`409 correction_conflict`); correct the latest record in the chain instead.

### 5. Triage an error

All JSON errors use `{ ok: false, error: { code, message, details? } }`.

| Status | Meaning | Look at |
|---|---|---|
| `400` | Invalid request body or ambiguous credentials | Read `error.message`; check unknown keys, idempotency-key format and time-trio agreement, and ensure a bearer is not combined with `lookie_forms_context` |
| `401` | No usable credential | The bearer or the context cookie |
| `403 origin_rejected` / `csrf_rejected` | The browser envelope | `Origin`, `X-CSRF-Token`, and the cookie from the same `GET` |
| `404` | Unknown tracker, no `forms.submit` on it, a kind that takes no entries (group, list, parent, or a form that has children), or a `supersedesRecord` that does not resolve | The id, the caller's grants, and the predecessor reference |
| `409` | `idempotency_conflict` or `correction_conflict` | The key, or which record you are superseding |
| `415` | Not `application/json` | `Content-Type` |
| `422 validation_error` | Values failed the schema | `error.details[].path` (for example `values.machine` with `is required`) |

A `400` can also reject mixed bearer and context-cookie credentials; use its
message to distinguish that from a body error.

### 6. Verify it landed

- A `201` returns `submissionId`, the stored `receipt`, and `receiptUrl`
  (`/forms/<id>/receipts/<submissionId>`, relative to the server). The receipt
  page is server-rendered, so a plain `GET` shows what was captured.
- `GET /api/forms/<id>/submissions?limit=50` (maximum 100) lists the caller's
  current entries, newest receipt first (`receiptAt`, not `eventAt`). Each record's `values` is a **list** of
  `{fieldId, fieldLabel, fieldType, value}` (selects add `selectedOptions`),
  not an object — index it by `fieldId`.
- **Superseded predecessors are not listed.** Only the head of each
  correction chain appears; the full chain is at
  `GET /api/forms/<id>/submissions/<submissionId>/history`. A predecessor
  missing from the list is a correction, not a lost record.
- A list-kind tracker has no submissions; read `GET /api/forms/<id>/list`.

## Designing a tracker

The platform will store whatever a template asks for, so the quality of the
data is decided at design time. These rules come from trackers filled in by
voice, by agents, and by thumb at the moment of the activity.

1. **Count the entry cost.** For every field, ask whether the person can say
   it in one breath to an agent and tap it in one go on a phone. A value that
   is usually unknown at entry time is optional; a value that is usually the
   same gets a `default`. Ask for what can be read off the object (a console,
   a label, a plate), not recalled from memory.
2. **Require only what makes the entry meaningless if missing.** Usually that
   is the time plus the one thing being measured. Everything else is
   optional. A required field the person cannot answer gets a guess, and a
   guess is worse than a blank.
3. **One enabled option is not a question.** A select with exactly one
   enabled option renders as a stamp. Disabled leftovers do not count. JSON
   callers may omit its value; see the quickstart.
4. **Unknown is not false.** The native form submits an unchecked checkbox as
   `false`; JSON preserves omission of an optional checkbox. Use a checkbox
   only when unchecked truly means "no" and the fact is always observed.
   For anything that may not have been noticed or asked, use an optional
   `select` with `yes` / `no`, so blank stays "unknown". An optional
   multi-select whose help says "leave empty if none" is fine.
5. **Order fields within the platform's sections.** The entry page groups
   selects and multi-selects first, numbers second, and other fields last,
   preserving field order within each group. Put the most frequently answered
   fields first within each section, and rarely used fields after the core
   ones. Make one tracker per thing physically used
   (a parent with children), with a group for the occasion that ties them
   together.
6. **Label with the name printed on the object.** Use the name on the machine
   plate or the product label (or both). An option the person cannot
   recognize gets logged as Other, and Other cannot be analyzed.
7. **Keep an escape hatch.** Offer `Other (say what in Notes)` plus a `notes`
   field, so a new case never blocks an entry. Add the real option the first
   time it is used.
8. **Numbers stay numbers.** Use `type: 'number'`, put the unit in the label
   (`Weight (lb)`), and set `constraints.minimum`, `constraints.maximum`, and
   `constraints.step` to accept every real reading. `component:
   'stepped-select'` renders a picker when those constraints define a
   supported finite range. Step alignment starts at `minimum`, or zero when
   absent. With a zero base, step 25 rejects 66; fix the constraint instead of
   rounding the measurement.
9. **Never break history.** Change a tracker as a new revision. Retire a field
   with `isDestroyed: true` instead of removing it, and make readers that
   chart it accept the old field or its replacement across the boundary.
   Relabeling an option is safe (receipts snapshot labels); changing a field's
   type or an option id changes the record shape for anything that charts it.

## GUI surfaces

- `/forms` — the root (groups, view switcher, create links, archived groups)
- `/forms/:id` — a tracker (entry form + recent entries), a list (checklist),
  or a group (member hub + archived members)
- `/forms/:id/entries` — history (day-grouped; aggregated for groups)
- `/forms/:id/receipts/:submissionId` — immutable receipt (+ supersede chain,
  inline correction), carrying the tracker's bar
- `/forms/:id/configure` — the builder: basics, parent/group selects, related
  picker, field editor, publish, clone/archive lifecycle
- `/forms/new` — create (accepts `?group=<id>` to pre-join,
  `?kind=container` for a new group, and `?kind=list` for a checklist; the ID
  derives from the name when left blank)
