# PROMPT-v3 — Lookie-Link Editable Mode (Direct Codex Run)

Repo: `/Users/chrisfonte/projects/lookie-link`
Branch: `main` (direct-to-main allowed for this task)
Related GitHub issues:
- #29 feat: make direct image links open actual image views
- #30 feat: add opt-in editable mode with safe save-to-disk flow
- #31 feat: add markdown/YAML editor UX for editable mode
- #32 docs: update README and validation coverage for editable mode

Read first:
- `/Users/chrisfonte/operations-incubator/specs/lookie-link-editor/SPEC.md`
- `/Users/chrisfonte/operations-incubator/specs/lookie-link-editor/CODEX-PROMPT.md`

Implement this in **4 staged phases** on `main`:
1. direct local image-link viewing
2. opt-in edit mode + safe save-to-disk
3. markdown/YAML editor UX
4. docs + validation

Rules:
- Base everything on what Lookie-Link already does today
- Keep plain Node + Express + server-rendered pages
- No framework rewrite
- Editing must be opt-in by config
- Images are view-only: embedded images still work, direct local image links must open/display cleanly
- Validate after each phase
- Commit after each successful phase
- Stop on regression
- Do not close GitHub issues yourself

Validation minimums:
- app startup works
- existing view mode still works
- direct image-link behavior works
- markdown save updates real file on disk
- YAML save updates real file on disk
- binary/directory rejection works
- path traversal blocked
- README updated for editable mode/security caveat

Return at end:
- commits created
- files changed
- phase-by-phase validation summary
- open risks/follow-ups

No stubs. Ship a working implementation only.

When completely finished, print a concise final summary in the terminal output.