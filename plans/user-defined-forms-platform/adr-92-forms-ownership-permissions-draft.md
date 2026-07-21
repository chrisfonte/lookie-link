> **Changelog — Revision 2 (2026-07-19):** Addresses adversarial-review R1 and advisories A1–A5; in particular, it separates the binding opaque-origin control from the open `/raw` form/popup compatibility-token decision.

# ADR-92: Forms ownership, permissions, CSRF, and raw-HTML boundary

> ## As-built status — 2026-07-21
>
> **Built and matching this ADR:** the sandbox token set `allow-scripts allow-forms
> allow-popups`, with no `allow-same-origin`, applied to artifact HTML; synchronizer CSRF token
> plus exact-Origin checking that fails closed when no public origin is configured;
> Post/Redirect/Get on native form submission; uniform 404s that conceal existence rather than
> leaking it.
>
> Two live vulnerabilities were found and fixed during implementation, both proven with real
> headless Chrome writing real files: `/embed` served artifact HTML same-origin with no CSP
> ([#164](https://github.com/chrisfonte/lookie-link/issues/164)), and `/asset/*.svg` served
> executable SVG the same way ([#165](https://github.com/chrisfonte/lookie-link/issues/165)).
>
> **Divergence — the permission model has no grant path.** `forms.manage` is defined but no
> configuration path grants it to a bearer token, so agents depend on ambient `unrestricted`
> access. Tracked as [#183](https://github.com/chrisfonte/lookie-link/issues/183).
>
> **Context this ADR predates.** There is still no authentication. Every caller resolves to
> `unrestricted`, and an unauthenticated caller is recorded as a principal named `operator` —
> so the ownership model described here is written but never exercised against a real
> unauthorised caller. Tracked as [#192](https://github.com/chrisfonte/lookie-link/issues/192)
> (explicit unauthenticated principal) and
> [#84](https://github.com/chrisfonte/lookie-link/issues/84) (verification).
>
> Triage record: `~/operations-system/plans/lookie-link-backlog-triage/`.



- **Status:** Accepted 2026-07-21 — partially implemented, see As-built status
- **Date:** 2026-07-19
- **Decision owners:** Lookie-Link operator and maintainers
- **Parent:** issue #90
- **Blocked by:** issue #91 baseline reconciliation
- **Scope:** issue #92 only; schema, persistence, deletion, and attestation format remain in issue #93

## Context

Lookie-Link is adding fixed, file-native form APIs, first-party `/forms` pages, and immutable submissions. The trust contract must be fixed before any mutation route ships: who the server says a caller is, who owns a resource, which capabilities act on it, how browser and agent credentials differ, what a submit-only caller may later read, and how denial avoids confirming that a private resource exists.

The architectural guardrails are binding: forms use fixed generic routes; definitions, forms, submissions, providers, and bindings remain separate resources; APIs validate canonical file mutations; first-party `/forms` rendering does not weaken sanitization; bindings are logical and operator-approved; capture precedes reactions; and submissions are private by default (`refs/issue-90.md`, **Architectural guardrails**). The approved plan further requires a central capability path, private submission lists, browser/JSON parity, and no unauthorized counts or errors (`plan-pkg/plans/user-defined-forms-platform/plan.md`, **API and Browser Surface**, **Identity, Authorization, and Safety**, and **Integration With Existing and Planned Features**).

Issue #92 originally framed a choice between single-operator v1 and authenticated multi-user ownership. That choice has since been made: the contract is multi-user from day one using Operator, User, Agent, and share-recipient identities, while the first runtime may implement only a configured local Operator plus Agent bearer tokens (`refs/issue-92.md`, **Operator direction (2026-07-15)**; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml`, `operator_decisions_2026_07_15`). Enabling a second real User principal is gated on cryptographically verifiable receipts.

### Current access-control reality and #91 boundary

The GitHub-main baseline is not this target contract:

- `gh-main/lib/access-control.js` (`parseAccessConfig`, `authenticateRequest`, and `canAccessPath`) understands `view`/`edit` permissions over repo/path scopes. With `humanDefault: full`, no credential becomes an unrestricted context with all repo/path access.
- That file's `extractPresentedToken` accepts either `Authorization: Bearer` or `?token=`, bearer wins if both are present, and `appendAccessToken` deliberately propagates a query token into links.
- `gh-main/lib/grant-store.js` (`buildAccessContextForGrant` and `authenticateGrantToken`) projects managed grants into the same repo/path `view`/`edit` context, accepts query-carried grant tokens, stores token hashes, and records issuer/subject audit lineage. It is a useful central-decision seam, not a forms permission system to copy.
- `deployed-copy/docs/AGENT-ACCESS-CONTROL.md`, **Request Flow**, describes broader route-level separation such as annotate, admin/configure, publishing, metadata filtering, and agent CLI/API access. That documented surface is broader than the `view`/`edit` grammar visible in the two `gh-main` modules; issue #91 must establish the authoritative baseline and issue state.

This ADR does not reconcile those differences. Forms consume the reconciled central principal/capability service from #53 and preserve the metadata non-disclosure and capability-separation direction of #83/#84; #85 may configure roots, bindings, and capability summaries but does not become a second authorizer (`plan-pkg/plans/user-defined-forms-platform/plan.md`, **Integration With Existing and Planned Features**).

### Threats that determine the decision

1. A body can forge `ownerId`, `userId`, receipt actor fields, or a binding outside the caller's scope.
2. A browser can attach ambient cookies or unrestricted local authority to a cross-site mutation.
3. Raw HTML currently executes as same-origin script. `gh-main/server.js`, the `GET /raw/:repo/*` handler, serves enabled HTML verbatim without a sandbox header, while `gh-main/lib/config.js`, **Raw HTML serving**, explicitly warns that it can call `/api/save` or `/api/grants` with viewer authority.
4. An API key in a URL leaks through history, logs, links, and referrers. Current `extractQueryToken` and `appendAccessToken` make that a real compatibility concern rather than a hypothetical one.
5. A submit-only caller needs its just-created receipt but must not gain list access or read-by-ID access to anybody else's record (review B3).
6. Listing, errors, counts, cursor behavior, audit content, and metadata can reveal private forms or health-adjacent submission context even when record bodies remain protected.

## Decision

### 1. Identity and ownership contract

**DECIDED — Multi-user contract, initially limited provider set.** The contract recognizes the identity taxonomy below. The v1 runtime may expose only a configured local Operator and Agent API keys, but it must not use a special single-user schema or bypass the central decision function (`refs/issue-92.md`, **Operator direction**; `plan-pkg/plans/user-defined-forms-platform/plan.md`, **Open Decisions — Answered by Independent Review**, answer 3).

| Principal kind | Authentication contract | May own a template/form? | Default forms posture |
|---|---|---:|---|
| `operator` | Configured local operator context now; elevated browser session later | Yes | Instance-wide capabilities |
| `user` | SSO or local-password browser session | Yes | Own-resource access only, subject to granted capabilities |
| `agent` | First-class API key or compatibility static/grant bearer token, resolved to a stable agent ID | Yes | Only key/grant capabilities and resource scopes |
| `share_recipient.anonymous` | Share URL/password, no stable user session | No | No forms access in v1; later only an explicit share scope |
| `share_recipient.magic_link` | Short-lived recipient session | No | No forms access in v1; later only an explicit share scope |
| `share_recipient.credentialed` | User session plus explicit share scope | No separate share-owned resources | Share scope only unless separately admitted as a User |

This taxonomy comes from `gh-main/research/commercialization/lookie-link-publish-api-cli-public-link-evaluation-2026-06-01.md`, **Addendum 2026-06-01c — Identity and auth model + commitment signal**, and is made binding for forms by issue #92.

**NEW DECISION ND-1 — Canonical principal and owner references.** The principal service returns a server-only object with stable `kind`, `id`, `credentialKind`, and non-secret `credentialId`; browser principals may additionally have `sessionId`, while grant-backed agents may have `grantId`. Template and form records store `owner: { kind, id }`; submission records separately store the form owner and `submittedBy: { kind, id }`, never a credential secret or display label.

*Justification:* Stable identity IDs survive API-key rotation and SSO-provider changes, whereas token names, emails, and session IDs do not. Separating form ownership from submitter identity makes default submission visibility enforceable without moving the canonical file.

Create operations always derive the owner from the authenticated principal. Every request schema is a strict allowlist, and unknown fields are rejected by default as required by the plan's validation contract. Thus server-only fields such as `owner`, `ownerId`, `userId`, `principal`, `submittedBy`, `actor`, and `attestation` are illustrative forbidden inputs rather than a denylist that handlers attempt to keep exhaustive. Owner transfer and operator create-on-behalf are outside v1 and require a later audited central-auth contract.

**DECIDED — Unrestricted local mode is a principal provider, not an authorization bypass.** When enabled, an uncredentialed first-party browser maps to the configured stable local principal `{ kind: "operator", id: <configured, default "operator"> }`, and the ordinary capability engine grants it instance-wide forms authority (`plan-pkg/plans/user-defined-forms-platform/review-fable.md`, **Answers to the open decisions**, answer 3). Every device that can reach such an instance therefore has operator authority; forms enablement must state this LAN/tailnet exposure plainly, and mixed-trust deployments must disable unrestricted mode.

Before configuration permits a second real `user` principal, the startup/config validator must refuse enablement unless server-attested receipts use a verifiable signature or MAC. The exact receipt algorithm and representation belong to ADR #93, but this gate is part of the identity contract (`refs/issue-92.md`, **Operator direction**).

### 2. One capability grammar and one decision path

**DECIDED — Resource-kind capability names.** Forms add the approved capabilities below to the same central `<resource-kind>.<verb>` evaluator used by repo/path and future `pages.*` decisions; route handlers do not compare roles or tokens themselves (`plan-pkg/plans/user-defined-forms-platform/plan.md`, **Capabilities** and **User-defined pages (successor direction)**). The evaluator accepts the principal, capability, logical resource kind/ID, owner reference, and configured scope/binding context, and returns one allow/deny result plus a non-secret reason code for audit.

| Capability | Meaning |
|---|---|
| `forms.view` | List/read templates and forms in scope, including management-safe metadata. |
| `forms.manage` | Create, edit, validate, preview, publish, clone, instantiate, and explicitly upgrade definitions in scope. It never implies binding management. |
| `forms.submit` | Read the render-safe runnable form contract, submit to it, and retrieve only the caller's resulting receipt. |
| `forms.read_submissions` | List and read submissions for forms in the granted scope. |
| `forms.manage_bindings` | Select/change approved destination, option-provider, or reaction bindings; the binding registry still checks that the selected logical ID is allowed. |

`forms.manage_bindings` is conjunctive: a definition mutation that touches binding fields requires both `forms.manage` and `forms.manage_bindings`. Owner equality narrows scope but never substitutes for a required capability; conversely, cross-owner access requires an explicit resource scope/grant even when the principal has the named capability.

**NEW DECISION ND-2 — Capability semantics, defaults, and submitter receipt entitlement.** Operator receives all forms capabilities instance-wide. A User's default grants apply only to owned resources (`forms.view`, `forms.manage`, `forms.submit`, and `forms.read_submissions`); `forms.manage_bindings` always requires an explicit operator grant, Agents receive only key/grant scopes, and share recipients receive none in v1. Successful `forms.submit` also derives a non-grantable effective entitlement `forms.read_own_submission` for the immutable record whose server-stamped `submittedBy` equals the current stable principal; it permits the browser receipt and single-record API projection, but never lists, searches, reads a different ID, exposes management metadata, or permits template/binding mutation.

*Justification:* Owner-scoped defaults make ordinary human ownership useful while keeping high-impact bindings and every Agent action explicitly granted. The receipt entitlement satisfies review blocker B3 and durable Post/Redirect/Get without turning possession of a guessable ID into authority.

Default multi-user visibility is therefore: Operator; the stable submitting principal via `forms.read_own_submission`; and principals explicitly granted `forms.read_submissions` over that form. Form owners receive `forms.read_submissions` for their own forms by default; Managers and Agents receive no cross-owner history without an explicit scope, and a binding may broaden delivery/read visibility only through an operator-approved central grant. Submit-only and share-recipient principals never enumerate prior submissions or manage templates/bindings.

### 3. Proposed route policy matrix

**NEW DECISION ND-3 — Route policy matrix and browser receipt route.** The following matrix is normative for the route family proposed in `plan-pkg/plans/user-defined-forms-platform/plan.md`, **API and Browser Surface**. “Session” includes the v1 local-operator browser context; “bearer” means the `Authorization` header and never a URL token.

*Justification:* A single matrix makes every route's principal, capability, browser-envelope checks, and non-disclosing denial mechanically testable. The additional first-party receipt route makes the required durable Post/Redirect/Get flow concrete without granting list access.

Denial codes used below:

- **A401:** no acceptable credential/principal, or an invalid/expired credential; authenticate before resource lookup and return the same generic body.
- **E404:** for an item/slug, absent and authenticated-but-out-of-scope are the same `404` status, body, headers, and timing class.
- **L200:** a collection returns `200` with only allowed rows; no capability or no visible rows produces the same empty shape, with counts/cursors computed after filtering.
- **C403:** an authenticated caller lacks a collection-level create capability; this reveals no resource ID.
- **B403:** browser Origin/Referer or CSRF failure, checked before resource lookup and body-driven mutation, with one generic response.
- **Q400:** any route in this matrix carrying a `token` query parameter, or any request mixing bearer and browser-session credentials, is rejected before credential selection.

| Route | Accepted principal / credential | Capability and scope | CSRF / Origin posture | Denial response |
|---|---|---|---|---|
| `GET /api/form-templates` | Session or agent bearer | `forms.view`; filter by owner/grant scope | Safe method; no CSRF | Q400, A401, or L200 |
| `POST /api/form-templates` | Session or agent bearer | `forms.manage`; owner is server-derived caller | Session: Origin/Referer + CSRF; bearer: no CSRF | A401, Q400, B403, or C403 |
| `GET /api/form-templates/:templateId` | Session or agent bearer | `forms.view` in item scope | Safe method; no CSRF | Q400, A401, or E404 |
| `PATCH /api/form-templates/:templateId` | Session or agent bearer | `forms.manage`; add `forms.manage_bindings` if binding fields can be touched | Session checks; bearer exemption | A401, Q400, B403, or E404 |
| `POST /api/form-templates/:templateId/validate` | Session or agent bearer | `forms.manage` in item scope | Session checks; bearer exemption | A401, Q400, B403, or E404 |
| `POST /api/form-templates/:templateId/preview` | Session or agent bearer | `forms.manage` in item scope | Session checks; bearer exemption | A401, Q400, B403, or E404 |
| `POST /api/form-templates/:templateId/publish` | Session or agent bearer | `forms.manage` in item scope | Session checks; bearer exemption | A401, Q400, B403, or E404 |
| `POST /api/form-templates/:templateId/clone` | Session or agent bearer | `forms.view` on source **and** `forms.manage` to create server-owned clone | Session checks; bearer exemption | A401, Q400, B403, or E404 for hidden/absent source; otherwise C403 |
| `GET /api/forms` | Session or agent bearer | `forms.view`; filter by owner/grant scope | Safe method; no CSRF | Q400, A401, or L200 |
| `POST /api/forms` | Session or agent bearer | `forms.manage`; also `forms.manage_bindings` for any non-default binding selection | Session checks; bearer exemption | A401, Q400, B403, or C403 |
| `GET /api/forms/:formId` | Session or agent bearer | `forms.view` in item scope | Safe method; no CSRF | Q400, A401, or E404 |
| `PATCH /api/forms/:formId` | Session or agent bearer | `forms.manage`; also `forms.manage_bindings` when a binding field changes | Session checks; bearer exemption | A401, Q400, B403, or E404 |
| `POST /api/forms/:formId/upgrade-template` | Session or agent bearer | `forms.manage` on form and `forms.view` on target template version | Session checks; bearer exemption | A401, Q400, B403, or E404 if either target is hidden/absent |
| `GET /forms/:slug` | Browser session/local context | `forms.submit` **or** `forms.view`; return only render-safe runnable fields | Safe method; sets/uses browser context and emits CSRF token | Q400, A401, or E404 |
| `POST /forms/:slug/submissions` | Browser session/local context | `forms.submit` in form scope | Origin/Referer + synchronizer CSRF required; route-scoped form body | A401, Q400, B403, or E404 |
| `POST /api/forms/:formId/submissions` | Agent bearer, or a first-party session JSON client | `forms.submit` in form scope | Bearer: no CSRF; session: Origin/Referer + CSRF | A401, Q400, B403, or E404 |
| `GET /api/forms/:formId/submissions` | Session or agent bearer | `forms.read_submissions` in form scope; never satisfied by submit-only | Safe method; no CSRF | Q400, A401, or E404; authorized result is filtered/paginated |
| `GET /api/form-submissions/:submissionId` | Session or agent bearer | Operator, scoped `forms.read_submissions`, or derived `forms.read_own_submission` | Safe method; no CSRF | Q400, A401, or E404 |
| `GET /forms/:slug/submissions/:submissionId/receipt` | Browser session/local context | Derived `forms.read_own_submission`, scoped `forms.read_submissions`, or Operator; slug/record must match | Safe method; no CSRF | Q400, A401, or E404 |

The final row is the added browser receipt route. It returns the receipt ID, form ID, schema/template version, server receipt timestamp, storage result, and the submitter's own escaped submitted values; it omits owner administration, bindings, other submissions, audit details, and reaction internals. Including `:slug` lets the resolver require a consistent form/submission relationship without revealing either mismatch.

### 4. Non-disclosure and authorization ordering

**NEW DECISION ND-4 — Uniform target concealment.** Authenticated item reads and target mutations use E404 for absent, foreign-owner, out-of-scope, and missing-capability cases; collection reads are capability-filtered L200 responses. A401, Q400, B403, content-type `415`, and size `413` checks run without looking up a target; after those checks, the resolver retrieves and authorizes as one operation so handlers cannot branch into revealing errors.

*Justification:* Uniform item responses and post-filter pagination meet issue #92's no-existence-leak criterion while retaining standards-appropriate authentication and request-envelope errors. Operators get diagnostic reason codes only in the redacted audit stream.

Unauthorized resources must not affect total counts, facets, validation messages, `Link` headers, cursor existence, timing-dependent secondary fetches, option/provider labels, submission metadata, or search/discovery output. E404 bodies do not echo the requested ID or distinguish owner mismatch, template mismatch, missing version, inactive form, or binding denial. Validation and stale-revision errors are returned only after the caller is authorized to know the target.

### 5. First-party browser sessions, Origin, and CSRF

**DECIDED — Layered browser policy.** CSP sandboxing of `/raw` is load-bearing; exact Origin/Referer validation is the primary browser mutation check; synchronizer CSRF tokens are defense-in-depth (`plan-pkg/plans/user-defined-forms-platform/review-fable.md`, blocker **B1** and answer 7; `plan-pkg/plans/user-defined-forms-platform/plan.md`, **CSRF and same-origin risk**). Authorization remains mandatory after all browser-envelope checks.

**NEW DECISION ND-5 — Browser context and synchronizer-token mechanics.** Every first-party browser flow uses an opaque, server-side browser-context ID in an `HttpOnly`, `SameSite=Lax`, path `/` cookie, marked `Secure` whenever TLS is used; authenticated sessions rotate the ID at login/elevation and destroy it at logout/expiry. The server stores a random CSRF secret in that context, emits it only in first-party form bodies or a management-UI response header, and accepts it from a hidden form field or `X-CSRF-Token` using constant-time comparison.

*Justification:* A server-side synchronizer token works for both future authenticated sessions and today's unrestricted local browser context without placing authority or principal IDs in a client-editable cookie. Rotation prevents a pre-authentication context from being fixed into an authenticated one.

For every cookie/ambient-authority mutation:

1. Resolve the one configured canonical public origin; proxy-derived scheme/host are trusted only when the proxy itself is explicitly trusted.
2. If `Origin` is present, require an exact scheme/host/port match. `Origin: null`, multiple/invalid values, suffix matches, and merely same-site origins are rejected.
3. If `Origin` is absent, require a valid `Referer` whose origin exactly matches; if both are absent, reject. If both are present, both must be consistent.
4. Require the session-bound CSRF token, then authenticate/authorize, validate, and mutate. Every failure produces zero canonical, temporary, index, outbox, or audit-payload filesystem change other than the permitted redacted rejection audit event.

Browser form POST accepts only a route-scoped, size-limited `application/x-www-form-urlencoded` parser. Browser JSON management calls require `application/json`; method-override parameters are not supported. `SameSite` cookies are not accepted as a substitute for Origin or CSRF checks.

### 6. Agent bearer-token policy

**DECIDED — Agent JSON requests are stateless bearer requests.** Agents never authenticate with a browser session and send API keys/grant tokens only as `Authorization: Bearer <secret>`; because that credential is explicit rather than ambient, bearer-only requests are exempt from CSRF (`gh-main/research/commercialization/lookie-link-publish-api-cli-public-link-evaluation-2026-06-01.md`, **Credential types** and **Agent API key model**; `plan-pkg/plans/user-defined-forms-platform/plan.md`, **CSRF and same-origin risk**). CORS is not enabled for agent APIs, and form mutations retain strict JSON content type, authorization, size, and rate limits.

**NEW DECISION ND-6 — Reject URL and ambiguous credentials across the forms surface.** Every route in the matrix rejects `?token=` before authentication, including reads, management mutations, submissions, and receipts. A request presenting both bearer and a browser session is rejected rather than choosing precedence, and secrets are never copied into redirects, generated links, receipts, errors, or audit records.

*Justification:* This closes the concrete leakage path created by current `extractQueryToken`/`appendAccessToken` behavior and makes the acting principal unambiguous. It is deliberately stricter than legacy non-forms routes, whose migration belongs to #91/#111.

API-key/grant lookup must use constant-time secret comparison or hashed lookup, resolve to a stable Agent principal plus non-secret key/grant ID, and enforce expiry/revocation for every request. Management and submission endpoints do not accept share tokens, magic-link tokens, basic auth, body credentials, or cookie fallback for an Agent.

### 7. `/forms` versus `/raw`

**DECIDED — Origin isolation is the raw-HTML boundary.** Every `/raw` response that can render HTML carries a `Content-Security-Policy: sandbox ...` directive that includes `allow-scripts` and forbids `allow-same-origin`, on direct navigation as well as embedding and through conditional/range handling. Omitting `allow-same-origin` gives the document an opaque origin, so its requests fail the browser mutation Origin policy and it cannot read first-party form pages to harvest CSRF tokens (`refs/issue-92.md`, **Correction (2026-07-15)**; `plan-pkg/plans/user-defined-forms-platform/review-fable.md`, blocker **B1**; `plan-pkg/plans/user-defined-forms-platform/user-defined-forms-platform.yaml`, decision **AD-9**). The recorded operator decision establishes that raw artifacts are content, no supported raw artifact intentionally calls Lookie APIs, and CSP sandboxing enforces that separation; it does not ratify the exact non-security compatibility-token set.

**NEW DECISION ND-7 — Raw remains a non-privileged artifact viewer.** No profile may add `allow-same-origin` or authorize a raw document as a form renderer, submitter, manager, or bearer client. V1 also omits `allow-top-navigation`: a raw artifact may present an ordinary link that the user separately navigates to a first-party `/forms` page, but it may not navigate its parent automatically. The profile includes `allow-forms` and `allow-popups` as compatibility tokens (operator decision, 2026-07-19 — see Open questions section); this is a compatibility choice, not part of the security control.

*Justification:* The opaque origin, exact browser Origin policy, and ordinary capability checks hold the Lookie API boundary. With `allow-same-origin` absent, adding `allow-forms` or `allow-popups` does not restore ambient Lookie authority; those tokens therefore concern artifact compatibility, not the binding B1 security control.

Permissions still gate `/raw` reads, and CSP does not sanitize the artifact or make its content trustworthy. Issue #106 implements the header and #133 must run a real browser canary in which raw script attempts to fetch a form page, extract its token, and mutate a form with credentials included: with the header, the attempt is refused and every forms filesystem snapshot is unchanged; removing the CSP header must make the negative test fail. Forms mutations may not ship until that canary is active.

### 8. Audit and sensitive-data redaction

**DECIDED — Audit is allowlisted metadata, never form content.** Audit publication/lifecycle/binding changes, submission acceptance and rejection class, deletion authorization, and reaction dispatch using: submission/form/template IDs; template version; schema digest; principal kind/ID; non-secret session/key/grant ID; outcome class; server timestamps; request/payload byte counts; logical destination binding ID; and a request/event ID. Never record field values, notes, field/option labels, template/form titles, raw request bodies, cookies, bearer/query tokens, CSRF tokens, idempotency keys, share URLs/passwords, emails, or filesystem paths (`plan-pkg/plans/user-defined-forms-platform/plan.md`, **Audit and privacy** and answer 6; `plan-pkg/plans/user-defined-forms-platform/review-fable.md`, **N8 — Audit by ID, not title**).

Outcome classes are stable enums such as `accepted`, `rejected_authn`, `rejected_authz`, `rejected_origin`, `rejected_csrf`, `rejected_validation`, `rejected_size`, and `rejected_idempotency`; human-readable validation detail stays in the authorized response, not audit. The additional authentication, Origin, and size classes are an intentional diagnostic superset of review-fable answer 6's minimum enumeration and remain subject to the same allowlist and redaction rules. Audit readers must themselves be authorized, and an unauthorized caller never receives the audit reason code that distinguishes nonexistent from forbidden.

### 9. Required request sequences

#### First-party browser submission

```mermaid
sequenceDiagram
    autonumber
    actor B as Browser
    participant R as First-party /forms route
    participant P as Principal + capability service
    participant S as Submission service
    participant F as Durable file store

    B->>R: GET /forms/:slug (browser-context cookie if present)
    R->>P: Resolve session/local Operator; authorize forms.submit or forms.view
    P-->>R: Principal + allowed runnable projection
    R-->>B: 200 escaped form + session-bound CSRF token
    B->>R: POST urlencoded values + cookie + CSRF token<br/>Origin: configured first-party origin
    R->>R: Reject query token; validate Origin/Referer and CSRF before lookup
    R->>P: Resolve principal; authorize forms.submit on concealed target
    P-->>R: Allowed principal and owner/form context
    R->>S: Validate against pinned version; stamp submittedBy server-side
    S->>F: Exclusive durable write
    F-->>S: Durable submission ID and storage result
    S-->>R: Receipt + derived read-own entitlement basis
    R-->>B: 303 Location: /forms/:slug/submissions/:id/receipt
    B->>R: GET receipt with same browser context
    R->>P: Authorize read-own / scoped read / Operator
    R-->>B: 200 escaped receipt projection
```

#### Agent bearer JSON submission

```mermaid
sequenceDiagram
    autonumber
    actor A as Agent
    participant R as JSON forms API
    participant P as Principal + capability service
    participant S as Submission service
    participant F as Durable file store

    A->>R: POST /api/forms/:formId/submissions<br/>Authorization: Bearer API_KEY<br/>Content-Type: application/json
    R->>R: Reject ?token, cookies+bearer, wrong content type, or oversized body
    R->>P: Hash/constant-time authenticate key; resolve stable Agent
    P->>P: Check forms.submit and form resource scope
    P-->>R: Allowed Agent principal or generic denial
    Note over R,P: Bearer is explicit authority; no CSRF token required
    R->>S: Validate pinned schema; stamp Agent/key IDs server-side
    S->>F: Exclusive durable write
    F-->>S: Durable submission ID and storage result
    S-->>R: Receipt
    R-->>A: 201 JSON receipt (replay may return original per #97)
```

### 10. Verification contract

Tests must exercise the central decision service and full route stack, not route-local mocks alone. Each rejected mutation snapshots canonical definitions/submissions, temporary files, index/outbox state, and binding configuration before/after and asserts no change; a redacted rejection audit event is the only permitted side effect.

| Fixture | Required assertions |
|---|---|
| Unrestricted Operator | No-credential first-party context resolves to the configured stable Operator; all route families work through capability checks; owner/submitter are server-stamped; browser Origin + CSRF are still mandatory. |
| Scoped Agent | Bearer key can list/read/manage/submit only granted form IDs/owners and allowed bindings; key rotation preserves Agent identity; query token, browser cookie, foreign owner, and out-of-scope IDs fail without leakage. |
| Submit-only | Can render the runnable form, submit by browser and bearer as applicable, follow the 303, and reload/read exactly its own receipt; list is unavailable and another submission ID, template management, and binding changes are E404/C403. The non-Operator browser case uses a test-injected synthetic User principal to exercise the contract: it is not a production v1 runtime path until #93's verifiable-receipt gate permits a second real User. |
| Manager | A User/Agent with `forms.manage` can manage definitions in its explicit scope but cannot change bindings without `forms.manage_bindings` or read history without `forms.read_submissions`; granting each capability changes only that behavior. |
| Cross-owner | Two Users own separate templates/forms; owner defaults and explicit scopes never cross; lists/counts/cursors exclude the other owner and direct lookup/mutation returns the same E404 as random IDs. |
| Denied caller | Missing, invalid, expired, or revoked credentials produce generic A401 before lookup; valid no-capability principals get L200/C403/E404 as specified, with no filesystem mutation. |

The suite also requires:

- Table-driven coverage of every route row for session, bearer, query token, mixed credentials, capability, owner/scope, CSRF posture, and exact denial class.
- Origin cases for exact configured origin, wrong scheme/host/port, suffix attack, `Origin: null`, conflicting Origin/Referer, missing both, untrusted proxy headers, absent/invalid/replayed-after-session-rotation CSRF tokens, and valid same-origin requests.
- Collection non-disclosure tests proving counts, empty shapes, cursors, option/provider metadata, search/discovery, and response bodies do not vary with hidden records.
- Audit snapshot tests proving allowed metadata is present and titles, labels, values, notes, bodies, paths, emails, idempotency material, CSRF material, and credential secrets are absent on success and every rejection class.
- The #133 browser test described above, plus a mutation canary that removes the CSP header and must fail because the raw page regains same-origin token-harvesting ability.
- A configuration gate test proving a second User cannot be enabled until #93's signed/MAC receipt verifier is active.

## Consequences

### Positive

- Ownership and submission privacy do not require a schema migration when real Users/SSO arrive.
- Operator, User, Agent, and later share-recipient access share one principal/capability path; future `pages.*` adds a resource kind, not a second auth system.
- Submit-only workflows get durable receipts without history enumeration or bearer secrets in URLs.
- The raw boundary is held by browser origin isolation rather than a token that same-origin script can steal.
- Uniform 404/filtering and audit redaction cover direct routes and metadata side channels.

### Costs and risks

- Even unrestricted single-operator deployments need a browser context, Origin configuration, and CSRF state.
- Operators lose detailed forbidden/not-found errors at the caller surface; diagnosis moves to authorized redacted audit tooling.
- The decided profile prevents raw artifacts from navigating a parent, while permitting ordinary HTML form submission and sandboxed popups (`allow-forms`, `allow-popups` — operator decision 2026-07-19): those tokens preserve artifact compatibility and add no security exposure once the opaque-origin control is in place. Nothing may add `allow-same-origin` on the Lookie origin.
- Existing query-token links cannot call forms APIs, and forms will be stricter than legacy routes until #91/#111 reconcile the rest of the product.
- In unrestricted mode, network reachability remains Operator authority. This mode is unsuitable for a mixed-trust LAN or public listener.
- Multi-user activation depends on #93's verifiable receipt work, so runtime expansion can be blocked even after the forms slice works for one Operator and Agents.

## Alternatives considered

### Single-operator-only ownership

Rejected. It would reduce immediate code but contradicts the operator's binding direction and force record/permission migration before enabling a second User.

### Forms-only users, roles, token store, or grant evaluator

Rejected. It would duplicate #53/#83/#84 direction, diverge from managed grants and planned API keys, and make future `pages.*` another parallel policy system.

### Owner ID or actor supplied in request bodies

Rejected. Authorization and audit attribution must come from authenticated server state; operator create-on-behalf/transfer needs an explicit later workflow, not a trusted body field.

### `forms.submit` also grants listing/history

Rejected. It violates private-by-default submissions and issue #92's submit-only acceptance criterion.

### One-time receipt URL token

Rejected in favor of principal-bound `forms.read_own_submission`. A URL secret would complicate reloads and cross-device authenticated access, leak through normal URL handling, and reintroduce read-by-possession semantics.

### Detailed 403 responses for foreign resources

Rejected. They simplify debugging but disclose that the target exists; E404 plus authorized redacted audit preserves operator diagnosis.

### CSRF token as the raw boundary

Rejected by review blocker B1. A same-origin `/raw` script can fetch the form page and read any token before submitting it.

### Separate hostname for raw artifacts

Deferred, not required for v1. A separate origin can be a strong deployment option, but CSP `sandbox` without `allow-same-origin` provides the required opaque-origin boundary without DNS/TLS/port changes and is binding for #106; the decided profile adds the non-origin-restoring compatibility tokens `allow-forms` and `allow-popups`.

### `SameSite` cookies or Referer-only checks

Rejected as sole controls. Cookie semantics vary by navigation and same-site is broader than same-origin, while Referer can be absent; the adopted policy requires exact Origin with Referer fallback plus a synchronizer token.

### Query-string API tokens or bearer-precedence when credentials conflict

Rejected. Current code demonstrates how URL tokens propagate, and precedence makes actor attribution ambiguous; forms use one explicit credential channel.

## Open questions requiring operator decision

None. OQ-1 (raw artifact form/popup compatibility) was resolved by delegated operator decision on 2026-07-19 — see Decided below.

### Decided 2026-07-19 (operator decision, delegated): `/raw` sandbox profile is `sandbox="allow-scripts allow-forms allow-popups"`

`allow-forms` and `allow-popups` are granted; `allow-same-origin`, `allow-popups-to-escape-sandbox`, and `allow-top-navigation` remain forbidden. Rationale: the binding B1 security control is the opaque origin from omitting `allow-same-origin`; a sandboxed script can already `fetch()` arbitrary origins, so forms add no new exfiltration or CSRF capability (forms mutations reject the opaque origin), and popups inherit the sandbox. Omitting the two tokens therefore adds no security value while breaking form-submitting and popup-opening artifacts, contradicting the recorded 2026-07-15 "no compatibility casualties" operator decision. Revisit trigger: abuse observed in the artifact corpus or a change to the forms threat model.

## Review disposition

- **R1:** Adopted; the binding no-`allow-same-origin` control is separated from OQ-1's product-compatibility choice.
- **A1:** Adopted; ND-1 now specifies strict-allowlist validation with unknown-field rejection.
- **A2:** Adopted; the submit-only browser fixture now identifies its synthetic contract-level User.
- **A3:** Adopted; the expanded audit outcome enumeration is recorded as an intentional redacted superset.
- **A4:** Optional scoped authentication for `forms.manage` and `forms.manage_bindings` in otherwise-unrestricted mode is declined for v1. The approved plan permits unrestricted mode to map to all capabilities, and this ADR already requires explicit LAN/tailnet exposure warnings and disables unrestricted mode for mixed-trust deployments; changing that provider contract would exceed this revision's scope.
- **A5:** No content change required; it reports source-verification results and identifies no defect or proposed revision.
