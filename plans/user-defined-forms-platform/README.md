<!-- File: ~/projects/lookie-link/plans/user-defined-forms-platform/README.md -->

# User-Defined Forms Platform Plan Package

Status: Independent review complete — approve with required changes ([review-fable.md](./review-fable.md)). Implementation remains blocked on #91 and per-issue readiness marks.

This package plans a schema-driven, user-customizable forms platform for Lookie-Link. The product repository owns the plan because the work changes Lookie-Link itself. Deployment-specific configuration and captured personal data remain outside this public repository.

## Package index

- [plan.md](./plan.md) — architecture, sequencing, acceptance contract, and rollout gates.
- [findings.md](./findings.md) — current-state audit and design evidence.
- [user-defined-forms-platform.yaml](./user-defined-forms-platform.yaml) — machine-readable decisions, phases, dependencies, and review state.
- [review-brief-fable.md](./review-brief-fable.md) — independent analysis brief for Fable.
- [review-fable.md](./review-fable.md) — completed independent review: verdict, blocking findings B1–B5, open-decision answers.
- [progress.md](./progress.md) — append-only planning and review log.
- [CHANGELOG.md](./CHANGELOG.md) — package revision history.

## Review entry point

Start with [review-brief-fable.md](./review-brief-fable.md), then read [plan.md](./plan.md) and [findings.md](./findings.md). Review should challenge the architecture before any implementation issue is marked ready.

## GitHub coordination

- Draft plan pull request: [#89](https://github.com/chrisfonte/lookie-link/pull/89)
- Forms-platform epic: [#90](https://github.com/chrisfonte/lookie-link/issues/90)
- Blocking product-baseline reconciliation: [#91](https://github.com/chrisfonte/lookie-link/issues/91)

The epic owns the dependency-ordered child checklist. All implementation children remain planning-stage pending baseline reconciliation and independent review.
