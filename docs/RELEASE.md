# Release source and kit history

`main` is the release line and the base for new work. Green, reviewed pull requests
land there before a merged SHA is selected for deployment. Runtime deployment
commits record that source SHA and may live on a separate serving branch; use
[DEPLOYMENT.md](DEPLOYMENT.md) for checkpoint, apply, verification and push order.

The Ops kit manifest version is independent of the Node package version. Delivered
guides built from [guide-template.html](../kits/ops/guide-template.html) are standalone
HTML: literal inline CSS, embedded screenshots, no external font or script, and
Letter print rules. Lookie can distribute the template; a completed guide and its
exported PDF remain usable offline. Replace placeholders and inspect the final
artifact before delivery, including its HTML comments.

## Recovered kit history

Development history previously maintained outside `main` was published on
`feat/ops-kit-catalog-cards` and `feat/audio-markers` at `a754c6f`. It carries the
Ops kit through 1.30, including accessible diagrams and catalog cards, alongside
the viewer/API work that those kits use. The public refs preserve that provenance.

The recovery reached `main` on 2026-11-10 through this sequence:

1. [#393](https://github.com/chrisfonte/lookie-link/pull/393), head `ea66a18`,
   merged on 2026-11-04 as `f43bbd0`: fix no-config loader recursion, reset stale overlay
   selection on reload, add clean-process regressions and align the editable
   validator with the existing response envelope.
2. [#392](https://github.com/chrisfonte/lookie-link/pull/392), updated head
   `11ff4de`, merged as `4e75220`: add the standalone guide and Ops 1.31.
3. [#394](https://github.com/chrisfonte/lookie-link/pull/394), head `4e75220`,
   merged as `b844571`: integrate the 118-commit development stack into `main`.

`main` at `98b9925` was an ancestor of the recovered source. These merges required
no conflict resolutions; `b844571`, `4e75220` and `11ff4de` share the same tree.
The complete head of [#391](https://github.com/chrisfonte/lookie-link/pull/391),
`d9927ab`, is contained by ancestry, making that older PR redundant as an
integration vehicle. No feature from it was dropped.

The 1.31 guide changes no shared stylesheet bytes. Bundled pinned stylesheet
URLs serve the current effective version; the 1.31 bump replaces the 1.30 URL.
Already-inlined published revisions keep their exact CSS.

## Verification record

The previous `main` baseline passed 242 Node and 12 browser tests. The merged
source passed `npm run verify` and the separate editable validator with no
configuration supplied: 720 Node tests, 693 passes, 27 existing environment-based
skips and zero failures; all browser families ran without skips. Node 20/22 and
browser CI passed on #392, #393 and #394. A separate cross-family release review
accepted the guide and integration with zero findings, including a focused
50-test run and a two-page Letter PDF probe. Checks describe those source pins;
each deployment still needs its own runtime evidence.

No-config startup now works. The separate appearance-API limitation is recorded
in [configuration](CONFIGURATION.md#file-lookup-and-precedence).
