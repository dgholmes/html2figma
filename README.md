# html2figma

Capture any web page from Chrome and rebuild it as editable layers in Figma. Two parts:

- **Chrome extension** (`packages/extension`): captures the current tab into a `.h2f.json` design file. It scrolls the page first so scroll-reveal animations fire, forces leftover `opacity: 0` reveal targets visible, snapshots video frames, and inlines images and SVGs.
- **Figma plugin** (`packages/figma-plugin`): imports that file and creates frames, text (with fonts, weights, runs), image fills, gradients, shadows, strokes, and vectors at exact pixel positions.

A shared schema package (`packages/schema`) defines the `.h2f.json` document format and validates it on import.

## Install (personal use, no store)

```bash
npm install
npm run build
```

This builds both `packages/extension/dist` and `packages/figma-plugin/dist`. Run it before loading
either side — `dist/` is generated, so a fresh clone does not have it yet.

**Chrome:** open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, choose `packages/extension/dist`.

**Figma desktop:** **Plugins → Development → Import plugin from manifest…**, choose
`packages/figma-plugin/dist/manifest.json` — the copy inside **`dist/`**.

> If Figma reports `Unable to load code: ENOENT … packages/figma-plugin/main.js`, it was pointed at a
> manifest with no built code beside it. Run `npm run build`, then import the manifest from `dist/`.
> `packages/figma-plugin/manifest.template.json` is only the build input; it is not importable, and
> `dist/manifest.json` is generated from it.

## Use

1. Open the page in Chrome at the width you want (e.g. 1440 px). Scroll through it once; pause videos on the frame you want.
2. Click the extension icon → **Capture page**. Keep the tab in the foreground. A `<host>-<date>.h2f.json` file lands in Downloads.
3. In Figma run **html2figma**, drop the file in, click **Import into Figma**.

Options: *Reveal scroll animations* (default on), *Capture videos as still frames* (default on),
and *Image quality*.

**Copy to Figma.** After a capture the popup offers **Copy to Figma**: click it, then paste into
the plugin's box with Cmd/Ctrl+V. The capture never passes through extension storage, so there is
no small size cap — but it does live in the captured page, so copy before navigating away. The
downloaded `.h2f.json` remains the fallback and works regardless.

**Image quality** controls how images are stored. Images are kept at the size they are actually
displayed (times a density factor), encoded as JPEG when opaque and PNG only when they carry
transparency. *Balanced* (2x, the default) captured layrd.pro at 7.9 MB where storing source bytes
produced 42.2 MB; *High* uses 3x; *Original* keeps every image's source bytes untouched, which is
what you want if you intend to pull full-resolution assets out of the Figma file.

## Development

```bash
npm test               # unit tests (Vitest), all packages
npm run typecheck      # tsc --noEmit for every workspace
npm run build           # build the extension and the Figma plugin
npm run dev:extension   # rebuild on change; reload the extension in chrome://extensions
npm run dev:plugin      # rebuild on change; re-run the plugin in Figma
npm run test:browser    # fixture checks in headless Chromium (needs: npm i -D playwright && npx playwright install chromium)
npm run test:acceptance # end-to-end capture + import acceptance test against a real site (see below)
```

### Manual smoke test

Automated tests cover the capture and import logic in isolation, but only a real Chrome tab and a real Figma document exercise the whole pipeline end to end (loading the extension, running content-script capture on a live page, downloading the file, and importing it in the Figma desktop app). After `npm run build`:

1. **Load the extension.** `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/dist`.
2. **Load the plugin.** In Figma desktop: **Plugins → Development → Import plugin from manifest…** → `packages/figma-plugin/dist/manifest.json`.
3. **Capture a real page.** Open any page in Chrome at a fixed width (1440 px is a good default), scroll through it once so lazy content settles, then click the extension icon and **Capture page**. A `<host>-<date>.h2f.json` file should land in Downloads within a few seconds, with no error shown in the popup.
4. **Import it.** In Figma, run **Plugins → Development → html2figma**, drop the downloaded file into the plugin UI, and click **Import into Figma**. Check that: every section of the page shows its text (no blank bands where scroll-reveal content should be), any fixed header sits at the top of the imported frame, videos show a still frame or poster instead of an empty box, and the warnings list (if any) names real font/asset substitutions rather than dropped content.

### Automated acceptance test

`npm run test:acceptance` is a fully automated stand-in for the manual smoke test above, run against the real site that originally motivated this project (https://layrd.pro/, which hides ~27 sections at `opacity: 0` behind a scroll-linked reveal — exactly the kind of scroll-reveal content a naive capture tool renders as blank bands). It's a single command (`node packages/capture/test-acceptance/layrd.mjs`) that runs both halves itself:

1. Deletes any capture left over from a previous run, then builds `@h2f/capture`, launches headless Chromium at 1440×900, and navigates to the live site. If the site is unreachable (or responds with an error status), it prints a `SKIPPED` message and exits `0` — it never fails the suite for lack of network access, and it does **not** run the import half below, so an offline run can never print a line that reads as a pass.
2. Runs the real `capturePage()` against the live page (same code path as the extension) and asserts every major section captured visible, non-opacity-hidden text (checked on the text node itself and every ancestor frame up to the section root — `opacity: 0` is the literal mechanism this project exists to see through), that no section is a blank band, that the fixed header lands at `y ≈ 0`, that all five `<video>` elements produced an image fill (a captured frame or a poster) instead of a placeholder, and that `oklch()` section backgrounds resolved to real colors.
3. Only if every check above passed: writes the captured document, tagged with a fresh run id, to a temp file, then spawns a Vitest test (`packages/figma-plugin/test/acceptance.layrd.test.ts`) that feeds that same document through the plugin's real `Builder` against its existing Figma mock, asserting it builds without throwing, produces the exact expected node count, and creates zero `(import failed)` placeholder frames. That test checks the run id on the file it reads matches the one this run just wrote, so it can never silently pass against a stale capture.

Because that Vitest test reads from the OS temp directory rather than a repo path, it also runs harmlessly (and skips, printing no pass) as part of a plain `npm test`, with no network dependency — the OS temp file is either a fresh capture from the last successful `test:acceptance` run or, on a clean checkout / CI runner, absent.

## Limitations (v1)

Absolute positioning only (no auto-layout); iframes become placeholders; CSS masks and clip-paths are ignored; rotation is applied to leaf elements only; fonts not available in Figma fall back to Inter (listed in warnings).
