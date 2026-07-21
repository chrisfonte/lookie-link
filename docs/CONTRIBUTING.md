# Contributing

Changes are welcome. Describe only behavior implemented by the current tree, and update [CAPABILITIES.md](CAPABILITIES.md) whenever a route, permission gate, config key, discovery field/template, CLI command, or store capability changes. The discovery test parses that document and checks advertised templates against registered routes.

## Validation

Run:

```bash
npm test
npm run test:browser
npm run validate:raw-html
npm run validate:editable
npm run check:skill-packages
```

The browser suite uses Playwright Chromium at a phone viewport. If Chromium is
not installed or cannot launch in the current environment, its tests report a
visible skip instead of failing the rest of the suite. Failure screenshots are
left in the gitignored `test/browser/.artifacts/` directory.

If `docs/SKILL-SPEC.md` changes, run `npm run generate:skill-packages` before the checks.

## Renderer work

Preserve the renderer's security order: rewrite/decoration steps occur before DOMPurify, and sanitization remains the final untrusted-content step. Raw/transformed HTML is a separate opt-in trusted-content surface. Add route-level tests for any new viewer or MIME type, including access denial and host-path redaction.

## Stores and routes

Use `safeResolve` or the store's stronger realpath/symlink containment. Preserve uniform not-found behavior for managed resources, reject query credentials for mutations, keep secrets out of errors/output, and retain optimistic concurrency/atomic-write behavior.

For local smoke testing, use a temporary port and a disposable repository mapping. Do not add workstation-specific hosts, roots, repo names, or credentials to tracked files.
