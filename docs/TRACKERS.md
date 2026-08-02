# Trackers — the forms platform

Lookie-Link's second pillar. Files render documents; **Trackers** capture them:
small structured forms whose submissions accumulate into permanent, auditable
logs. A tracker is a form you return to — a gym machine, a medication log, a
weight check — and everything distinctive about the platform happens *after*
submission.

Enable it with the `forms:` block in the config (see
[CONFIGURATION.md](CONFIGURATION.md) and the annotated
`lookie-link.yaml.example`). Everything below assumes it is enabled.

## Three kinds (internal taxonomy)

Internally the platform has three kinds of template — the labels below are
for builders and this doc, not end-user marketing:

- **TRACKER** (`kind: 'form'`) — logs. Entry form, history, receipts.
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

End-user surfaces say **tracker** and **group**. The builder, the API, and the
storage say **form template**, **kind: 'container'**, and keep every URL under
`/forms/…`. This split is deliberate: creators get honest system words,
civilians get words that need no explanation, and the plumbing never churns
when the language does. This document uses each plane's words in its own
sections.

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
4. **Drafts revise; versions are frozen.** Templates use compare-and-set
   revisions (stale writes are rejected with a conflict) and publishing
   freezes an immutable numbered version. Removed fields are retained and
   marked `isDestroyed` rather than deleted, so old data always has a schema
   identity to resolve against.

## Templates and lifecycle

A template is a JSON document (`kind: 'form'` by default) with identity
(`templateId`, `title`), a `destinationId` alias, optional `presentation`
(theme, theme mode, submit label), optional structure (`containerId`,
`parentId`, `related`, `tags`), and `fields`.

Lifecycle: **create draft → revise (CAS on `revision`) → publish** (freezes a
`form-template-version` document carrying the schema digest and the structural
keys) → optionally **archive** (reversible; archived templates stop accepting
entries but keep serving history and receipts) or **clone**.

Field types: `short-text`, `long-text`, `number`, `checkbox`, `date`, `time`,
`datetime`, `select`, `multi-select`. Selects carry options with stable ids;
number fields support min/max/step; any field can set `default`, `required`,
`help`, and `showInList` (which values headline history rows).

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

- The root (`/forms`) is the groups page: a Groups | Trackers view switcher
  (Trackers lists every tracker under its group heading), quiet
  "+ New tracker · + New group" links beneath, and archived *groups* collapsed
  at the bottom.
- A group's bar: `Groups | Trackers | History | Configure`.
- A tracker's bar: `← <Group> | Log an entry | History | Configure`.
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
`Origin`); see [AGENT-ACCESS-CONTROL.md](AGENT-ACCESS-CONTROL.md) for the
access model.

| Operation | Route |
|---|---|
| List templates | `GET /api/forms/templates` |
| Read one (draft + `resolvedFields` for children) | `GET /api/forms/templates/:id` |
| Create draft | `POST /api/forms/templates` |
| Revise draft (CAS: send `revision`) | `PATCH /api/forms/templates/:id` |
| Publish | `POST /api/forms/templates/:id/publish` |
| Archive / restore | `POST /api/forms/templates/:id/archive` · `/restore` |
| Clone | `POST /api/forms/templates/:id/clone` |
| Submit an entry | `POST /api/forms/:id/submissions` |
| Read submissions | `GET /api/forms/:id/submissions` |
| Correction chain | `GET /api/forms/:id/submissions/:submissionId/history` |

Template keys accepted on create/patch include the structural set —
`kind`, `containerId`, `memberOrder`, `parentId`, `related`, `inherit` —
everything the GUI can do, the API can do.

## GUI surfaces

- `/forms` — the root (groups, view switcher, create links, archived groups)
- `/forms/:id` — a tracker (entry form + recent entries) or a group (member
  hub + archived members)
- `/forms/:id/entries` — history (day-grouped; aggregated for groups)
- `/forms/:id/receipts/:submissionId` — immutable receipt (+ supersede chain,
  inline correction), carrying the tracker's bar
- `/forms/:id/configure` — the builder: basics, parent/group selects, related
  picker, field editor, publish, clone/archive lifecycle
- `/forms/new` — create (accepts `?group=<id>` to pre-join and
  `?kind=container` for a new group; the ID derives from the name when left
  blank)
