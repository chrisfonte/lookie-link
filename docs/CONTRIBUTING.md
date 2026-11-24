# Contributing

Changes are welcome. Describe only behavior implemented by the current tree, and update [CAPABILITIES.md](CAPABILITIES.md) whenever a route, permission gate, config key, discovery field/template, CLI command, or store capability changes. The discovery test parses that document and checks advertised templates against registered routes.

Create branches from `main` and open pull requests into `main`. Merge green, reviewed changes through a pull request; retain branch history with ordinary merges and plain pushes. [RELEASE.md](RELEASE.md) explains the recovered development history and [DEPLOYMENT.md](DEPLOYMENT.md) separates source integration from runtime deployment.

## Validation

Run:

```bash
npm run verify
npm run validate:editable
```

`verify` is the exit-code-gated pre-commit check: Node tests, all browser families,
raw-HTML validation, and generated skill-package synchronization. `npm test` runs
the Node and browser suites. The editable validator remains a separate check.

The browser suite uses Playwright Chromium at desktop and phone viewports. If Chromium is
not installed or cannot launch in the current environment, its tests report a
visible skip instead of failing the rest of the local suite. CI requires the browser
tests to run without skips; install Chromium before claiming release acceptance.
Failure screenshots are
left in the gitignored `test/browser/.artifacts/` directory.

A configuration file is not a required CI input, and the suites never read the
host's. Every test entry point loads `test/helpers/host-isolation.js` first: the
npm `test:unit`, `validate:editable`, and `validate:raw-html` scripts and CI
preload it with `node --require`, and each browser spec imports it. It points
`HOME`, `USERPROFILE`, and the XDG base directories at a fresh temporary
directory, removes inherited `LOOKIE_LINK_*`, `PORT`, `HOSTNAME`, and
`ROOT_MAPPINGS` overrides, and sets `LOOKIE_LINK_CONFIG` to an empty config, so
neither `~/.config/lookie-link` nor a `lookie-link.yaml` in the checkout root is
consulted. Playwright keeps using the browsers installed under the real home;
set `PLAYWRIGHT_BROWSERS_PATH` to override. Tests that need configuration write
their own fixture and set `LOOKIE_LINK_CONFIG`.

Run single files the same way, for example
`node --require ./test/helpers/host-isolation.js --test test/kits.test.js`.
`test/host-isolation.test.js` fails when the Node suite starts without the
preload. Keep configured-mode checks separate.

If `docs/SKILL-SPEC.md` changes, run `npm run generate:skill-packages` before the checks.

## Renderer work

Preserve the renderer's security order: rewrite/decoration steps occur before DOMPurify, and sanitization remains the final untrusted-content step. Raw/transformed HTML is a separate opt-in trusted-content surface. Add route-level tests for any new viewer or MIME type, including access denial and host-path redaction.

## Stores and routes

Use `safeResolve` or the store's stronger realpath/symlink containment. Preserve uniform not-found behavior for managed resources, reject query credentials for mutations, keep secrets out of errors/output, and retain optimistic concurrency/atomic-write behavior.

For local smoke testing, use a temporary port and a disposable repository mapping. Do not add workstation-specific hosts, roots, repo names, or credentials to tracked files.
