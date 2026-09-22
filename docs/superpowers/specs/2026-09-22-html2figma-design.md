# html2figma — design spec

Date: 2026-09-22
Status: approved in conversation (approach, video handling, layout mode)

## 1. Goal

A self-hosted replacement for html.to.design: a Chrome extension that captures the
web page in the current tab as a structured design tree, and a Figma plugin that
rebuilds that tree as native Figma layers (frames, text, image fills, vectors).

The immediate acceptance target is https://layrd.pro/, where the paid tool produced
large blank bands. Root cause, verified in a live browser session:

- 27 blocks use scroll-reveal: `opacity: 0` plus a small `translate`/`scale`, with
  `transition: all`, revealed by an IntersectionObserver. A capture that never
  scrolls them into view exports invisible elements, leaving only section
  backgrounds (the black / light-gray / black / white bands).
- Five `<video>` elements are lazily sized and are 0 px tall until visible.
- The header is `position: fixed`, so it was exported at whatever scroll offset the
  capture happened at.
- Section backgrounds use `oklch()`; computed style returns them as `oklch(...)`,
  which naive `rgb()` parsers drop.

## 2. Decisions already made

| Decision | Choice |
| --- | --- |
| Architecture | Chrome extension (capture) + Figma plugin (import). No server. |
| Handoff | Extension downloads a `.h2f.json` file and copies it to the clipboard when under 5 MB. Plugin accepts a dropped or picked file, or pasted JSON. |
| Videos | Current frame drawn to canvas and stored as an image. Fallback: poster image. Last resort: labeled placeholder fill. |
| Layout | Absolute positioning: every element becomes a frame placed at its exact pixel offset inside its parent frame. Auto-layout inference is out of scope for v1. |
| Distribution | Chrome "Load unpacked" and Figma "Import plugin from manifest". No store publishing. |

## 3. Non-goals for v1

Auto-layout inference; components or variants; content of cross-origin iframes
(placeholder frame only); CSS `mask` and `clip-path`; hover or other interaction
states; responsive presets (the user resizes the window before capturing); URL
capture mode via headless browser; Firefox packaging. The capture code is kept free
of extension APIs so a URL mode can reuse it later.

## 4. Repository layout

npm workspaces monorepo, TypeScript throughout, Vite for both bundles, Vitest for
tests.

```
html2figma/
  package.json                 workspaces, root scripts (build, test, typecheck)
  tsconfig.base.json
  packages/
    schema/                    design-tree types + version constant + light validator
    capture/                   DOM -> design tree serializer (browser code, no extension APIs)
      src/
        index.ts               capturePage(options): Promise<CaptureResult>
        prepare.ts             reveal animations, eager-load images, wait for fonts, scroll to top
        walk.ts                DOM traversal -> Node tree
        geometry.ts            rects, transforms, rotation extraction
        paints.ts              background-color / background-image / gradients -> Paint[]
        text.ts                text runs, Range rects, font selection
        media.ts               img / picture / video / canvas / svg handling
        effects.ts             box-shadow, text-shadow, filter -> Effect[]
        color.ts               color string -> RGBA (pure parsers + canvas normalizer)
        css.ts                 small parsers: lengths, radius, transform matrices
        naming.ts              layer names
      fixtures/                hand-made HTML pages exercising each feature
    extension/                 Chrome MV3
      manifest.json
      src/
        background.ts          asset fetching, download, job state
        content.ts             injected on demand; runs capture, collects assets, assembles file
        popup/                 options + capture button + progress
    figma-plugin/
      manifest.json
      src/
        main/                  sandbox code: font resolution, node builder, progress
        ui/                    iframe: file drop / paste, asset preprocessing, progress display
  docs/superpowers/specs/
```

## 5. Design-tree schema (package `schema`)

```ts
export const SCHEMA_VERSION = 1;

export interface H2FDocument {
  version: 1;
  source: {
    url: string; title: string; capturedAt: string;      // ISO timestamp
    viewport: { width: number; height: number };
    devicePixelRatio: number; userAgent: string;
    fullPageHeight: number;
  };
  root: FrameNode;                                        // the page frame
  assets: Record<string, Asset>;
  warnings: string[];                                     // non-fatal capture issues
}

export type Asset =
  | { id: string; kind: 'image'; mime: string; data: string /* base64 */;
      width: number; height: number;
      origin: 'img' | 'background' | 'video-frame' | 'video-poster' | 'canvas' | 'svg-img' | 'placeholder' }
  | { id: string; kind: 'svg'; svg: string; width: number; height: number };

export interface RGBA { r: number; g: number; b: number; a: number }  // 0..1

export type Paint =
  | { type: 'solid'; color: RGBA }
  | { type: 'gradient'; gradient: 'linear' | 'radial' | 'angular';
      stops: { position: number; color: RGBA }[];        // position 0..1
      // linear: start/end in unit-square coordinates of the node box
      start: { x: number; y: number }; end: { x: number; y: number };
      // radial: center + radii in unit-square coordinates
      center?: { x: number; y: number }; radius?: { x: number; y: number } }
  | { type: 'image'; assetId: string; scaleMode: 'fill' | 'fit' | 'crop' | 'tile';
      // crop: normalized 3x2 transform of the visible sub-rectangle
      transform?: [[number, number, number], [number, number, number]];
      opacity?: number };

export interface Stroke {
  color: RGBA; weights: { top: number; right: number; bottom: number; left: number };
  align: 'inside'; dash?: number[];
}

export type Effect =
  | { type: 'drop-shadow' | 'inner-shadow'; color: RGBA; offset: { x: number; y: number };
      blur: number; spread: number }
  | { type: 'layer-blur' | 'background-blur'; radius: number };

interface NodeBase {
  id: string; name: string;
  x: number; y: number; width: number; height: number;     // relative to parent, pre-rotation
  rotation: number;                                        // degrees, Figma convention: positive = counter-clockwise (negate CSS rotate)
  visible: boolean; opacity: number; blendMode: string;   // CSS mix-blend-mode keyword
  fills: Paint[]; stroke?: Stroke; radius: [number, number, number, number];
  effects: Effect[]; clip: boolean;
  meta: { tag: string; id?: string; classes: string[]; position?: 'fixed' | 'sticky';
          pseudo?: 'before' | 'after' };
}

export interface FrameNode extends NodeBase { type: 'frame'; children: Node[] }

export interface TextNode extends NodeBase {
  type: 'text'; characters: string;
  runs: TextRun[];                                         // cover [0, characters.length) contiguously
  align: 'left' | 'center' | 'right' | 'justified';
  verticalAlign: 'top' | 'center' | 'bottom';
}

export interface TextRun {
  start: number; end: number;
  fontFamily: string;                                      // first family that resolved, CSS name
  fontWeight: number; italic: boolean; fontSize: number;
  lineHeight: number | null;                               // px, null = normal
  letterSpacing: number; color: RGBA;
  decoration: 'none' | 'underline' | 'strikethrough';
  textCase: 'original' | 'upper' | 'lower' | 'title';
}

export interface VectorNode extends NodeBase { type: 'vector'; assetId: string }  // svg asset

export type Node = FrameNode | TextNode | VectorNode;
```

Rules:

- Coordinates are CSS pixels at devicePixelRatio 1, relative to the parent's
  top-left. The root frame is `{ x: 0, y: 0, width: viewport.width, height: fullPageHeight }`.
- `radius` is `[topLeft, topRight, bottomRight, bottomLeft]`, already clamped to
  half the smaller side.
- Colors are gamma-encoded sRGB 0..1, alpha separate. Out-of-gamut colors are
  clipped to sRGB by the browser during normalization.
- Asset `data` is base64 without a data-URL prefix.

## 6. Capture pipeline (package `capture`)

`capturePage(options)` runs inside the page. It never touches extension APIs;
anything that needs privileges (cross-origin fetches, downloads) is done by the
caller through the `AssetLoader` interface it is given.

```ts
export interface AssetLoader {
  fetchAsBase64(url: string): Promise<{ mime: string; data: string } | null>;
}
export interface CaptureOptions {
  root?: Element;                 // default document.documentElement
  revealAnimations: boolean;      // default true
  captureVideoFrames: boolean;    // default true
  loader: AssetLoader;
  onProgress?: (stage: string, done: number, total: number) => void;
}
export interface CaptureResult { document: H2FDocument }
```

### 6.1 Prepare (`prepare.ts`)

1. Set every `<img loading="lazy">` to eager.
2. If `revealAnimations`: scroll the page from top to bottom in viewport-sized steps
   with a short wait per step (fires IntersectionObservers), wait 1.5 s, then scroll
   back to top and wait for one animation frame.
3. Force-reveal residuals: for every element whose computed `opacity` is `0` **and**
   whose `transition-property` includes `opacity` or `all` (an animation target,
   not something intentionally hidden), set inline `opacity: 1`,
   `transform: none`, `visibility: visible`, `animation: none`, and
   `transition: none` so the change applies immediately. Elements with a running
   `animation-name` get inline `animation: none` so they are captured at their
   resting state. Record each forced element in `warnings`.
4. Pause every `<video>` (keeps the current frame stable). Do not seek.
5. `await document.fonts.ready`; wait for all `<img>` in the tree to be `complete`
   (timeout 8 s, then continue with a warning).
6. Capture at `scrollY = 0`. Fixed elements are read at their top-of-page position
   and flagged `meta.position = 'fixed'`.
7. Restore every modified element's original `style` attribute after capture.

### 6.2 Walk (`walk.ts`)

Depth-first over element children, producing one `FrameNode` per rendered
element, plus `TextNode`s for DOM text and `VectorNode`s for inline `<svg>`.

Skip entirely: `script, style, link, meta, head, title, noscript, template`,
elements with `display: none`, elements whose bounding box is 0x0 and that have
no rendered descendants, and `<option>`.

Skip the frame but keep descendants (hoist children to the parent, adjusting
coordinates) when an element is `display: inline` (or `contents`) **and** has no
visual box styling (no background, border, shadow, outline, radius, transform,
opacity < 1, or overflow clip). This keeps `<span>`, `<a>`, `<b>`, `<em>` wrappers
from producing empty frames while preserving their text styles.

Elements with `visibility: hidden` become frames with `visible: false`; their
descendants are still walked because children can override visibility.

Per element the frame gets: geometry (6.3), fills (6.4), stroke (borders),
radius, effects (6.6), `clip` when `overflow-x` or `overflow-y` is not `visible`,
`opacity`, `blendMode`, and a name (6.8). Special tags are handled in `media.ts`
(6.5) and form controls (6.7).

Pseudo-elements: for `::before` and `::after` whose computed `content` is a
string other than `none`/`""`, synthesize a child node from
`getComputedStyle(el, '::before')`. Because pseudo-elements have no DOM node to
measure, geometry is estimated: use the pseudo's computed `width`/`height` when
not `auto`, positioned at the parent's content-box origin (or its end for
`::after`); if a dimension is `auto`, fall back to the parent's content box. Emit
a text node when `content` is a string with visible characters, otherwise a
frame carrying the pseudo's background and border. Record one warning per
estimated pseudo.

Cross-origin `<iframe>` becomes a gray frame named `iframe (not captured)`.

### 6.3 Geometry (`geometry.ts`)

- Base rect: `getBoundingClientRect()` plus `scrollX/scrollY`.
- Parent-relative: subtract the parent frame's absolute rect. Children of a
  scrolling container are offset by the container's `scrollLeft/scrollTop` so the
  visible region matches.
- Rotation: parse the computed `transform` matrix. If it decomposes to
  translate + uniform scale + rotation (no skew), emit `rotation` in degrees and use
  `offsetWidth/offsetHeight * scale` as the size, positioning by the transformed
  center. Otherwise fall back to the axis-aligned bounding box with `rotation: 0`.
- Sizes below 0.01 px are treated as 0; nodes with 0 width or height and no
  children are dropped.

### 6.4 Paints (`paints.ts`, `color.ts`)

Fill order in the schema is bottom to top (Figma order). For each element:

1. `background-color` if alpha > 0 -> solid.
2. `background-image` layers, iterated from last to first (CSS paints the first
   layer on top). `linear-gradient` / `repeating-linear-gradient` (treated as
   non-repeating) -> gradient paint with start/end computed per the CSS spec
   (angle -> gradient line length `|w sin a| + |h cos a|`, `to <side/corner>`
   keywords supported). `radial-gradient` -> radial centered with
   farthest-corner radius. `conic-gradient` -> angular. `url(...)` -> image
   paint; `background-size: cover` -> `fill`, `contain` -> `fit`, explicit
   sizes -> `crop` with a computed transform, any `repeat` -> `tile`.
3. `<img>`: image paint on the element frame using `currentSrc`;
   `object-fit: cover|fill` -> `fill`, `contain|scale-down` -> `fit`, `none` ->
   `crop`.

Color parsing: pure parsers for `transparent`, `#rgb[a]`, `#rrggbb[aa]`,
`rgb[a]()` (both comma and space syntax), and named colors via a table.
Anything else (`oklch`, `oklab`, `lab`, `lch`, `color()`, `hsl`, etc.) goes
through a 1x1 canvas normalizer: clear the canvas, set `fillStyle`, fill, and
read the RGBA pixel back with `getImageData` (exact to 8 bits including alpha).
The canvas path is memoized per input string.

### 6.5 Media (`media.ts`)

- `<img>`, `<picture>`: URL from `currentSrc`, deduped into `assets` via the
  loader. `.svg` sources become `svg` assets when the fetched text parses as SVG,
  otherwise image assets. On loader failure, try `drawImage` into a canvas (works
  for same-origin and CORS-enabled images); on `SecurityError` emit a placeholder
  asset and a warning.
- `<video>`: if `captureVideoFrames`, draw the current frame to a canvas sized to
  `videoWidth x videoHeight` and export PNG. On `SecurityError` (cross-origin
  without CORS) or `readyState < 2`, fetch `poster` through the loader. If neither
  works, a placeholder asset (dark gray) and the frame is named
  `video (frame unavailable)`. Placement uses `object-fit` like `<img>`.
- `<canvas>`: `toDataURL('image/png')`; on `SecurityError` a placeholder.
- Inline `<svg>`: clone the element, inline computed `fill`, `stroke`, `color`,
  `opacity` and `font` properties onto each descendant so `currentColor` and CSS
  classes survive, set explicit `width`/`height`/`viewBox`, serialize to string as
  an `svg` asset, emit a `VectorNode`. Children of the SVG are not walked.
- `<img>` whose asset is SVG also becomes a `VectorNode` so it stays editable.

Asset size guard: raster assets above 4096 px on either side are recorded as-is;
the plugin UI downsamples before import (Figma's limit is 4096 per side).

### 6.6 Text (`text.ts`)

For each DOM `Text` node with non-whitespace content (whitespace-only nodes are
kept only when `white-space: pre*` applies):

- Rect: union of `Range.getClientRects()` for the text node. Width is padded by
  1 px to absorb rounding so Figma does not wrap an extra line.
- Style from the parent element's computed style: `font-family` (first family in
  the list that `document.fonts.check()` reports available, else the first
  family), `font-weight`, `font-style`, `font-size`, `line-height` (`normal` ->
  null), `letter-spacing` (`normal` -> 0), `color`, `text-decoration-line`,
  `text-transform`. v1 writes the transformed characters (upper/lower/capitalize
  applied) and sets `textCase: 'original'`.
- `characters` is the text with `white-space` collapsing applied as the browser
  would (collapse runs of whitespace unless `pre`/`pre-wrap`); leading and
  trailing collapsible whitespace is trimmed.
- `align` from `text-align` (`start`/`end` resolved with `direction`);
  `verticalAlign: 'top'`.
- Adjacent text nodes under the same block parent with identical style are
  merged into one `TextNode` when their rects are vertically contiguous
  (line-broken text inside one element), so a paragraph stays one layer.
- `text-shadow` -> drop-shadow effect on the text node.

Font mapping happens in the plugin (7.3), not here: capture records the CSS
family, weight and italic flag only.

### 6.7 Form controls

`<input>` (non-hidden), `<textarea>`, `<select>`, `<button>`: a frame with the
element's box styling; text content is `value` or `placeholder` (placeholder
uses the `::placeholder` computed color when available, else `color` at 50%
alpha). `<select>` shows the selected option's label. Checkboxes and radios are
frames with a border and, when checked, a centered inner solid.

### 6.8 Naming (`naming.ts`)

`tag#id.class1.class2` truncated to 60 characters, with `#id` first when present
and at most two classes. Text nodes are named by their first 40 characters.
Fixed elements get the suffix ` (fixed)`, video frames ` (video)`, placeholders
` (not captured)`.

### 6.9 Output

`H2FDocument` assembled with `assets` keyed by a content hash of the base64 data
(dedupes repeated images such as gallery thumbnails with repeated sources).

## 7. Figma plugin

### 7.1 Manifest

`editorType: ["figma"]`, `documentAccess: "dynamic-page"`,
`networkAccess: { allowedDomains: ["none"] }` (all assets are inline, so the
plugin needs no network), `ui: "ui.html"`, `main: "main.js"`.

### 7.2 UI (iframe)

- Drop zone / file picker for `.h2f.json`, plus a textarea for pasted JSON.
- Validates `version === 1` and shows source URL, title, viewport, node count,
  asset count and total size before import.
- Option: "Create on a new page" (default on).
- Asset preprocessing: decode each `image` asset to an `ImageBitmap`; if either
  side exceeds 4096, scale down proportionally through an `OffscreenCanvas` and
  re-encode as PNG. Each SVG asset is also rasterized to PNG as a backup. Convert
  to `Uint8Array` and stream assets to the main thread one message per asset
  (`{ type: 'asset', id, bytes, width, height }`) followed by
  `{ type: 'tree', document }` with asset data stripped. Streaming keeps any
  single `postMessage` to a few MB.
- Progress bar driven by `progress` messages from main; final summary with
  warnings from capture and import (missing fonts, failed assets).

### 7.3 Main (sandbox) — `Builder`

1. Receive assets, call `figma.createImage(bytes)` per image asset and keep
   `assetId -> imageHash`. SVG assets are kept as strings.
2. Font resolution: collect distinct `(family, weight, italic)` from all text
   runs. Fetch `figma.listAvailableFontsAsync()` once. For each requested family,
   find a Figma family by case-insensitive exact name, then by stripping quotes
   and common suffixes; if none, fall back to `Inter`. Pick the style whose
   parsed weight is nearest to the CSS weight and whose italic flag matches
   (style names are parsed: Thin 100, ExtraLight 200, Light 300, Regular 400,
   Medium 500, SemiBold 600, Bold 700, ExtraBold 800, Black 900, with `Italic`
   detection). `loadFontAsync` each resolved font; record substitutions as
   warnings.
3. Optionally create a new page named after the document title, then build the
   root frame at `(0, 0)` and rebuild recursively:
   - Frame: `createFrame()`, `resize(w, h)`, `x/y`, `rotation`, `fills`,
     `strokes` + per-side `strokeTopWeight` etc. with `strokeAlign = 'INSIDE'`,
     `topLeftRadius` ..., `effects`, `clipsContent`, `opacity`, `blendMode`
     (CSS keyword -> Figma enum, unknown -> `NORMAL`), `visible`, `name`.
   - Text: `createText()`, load and set the resolved `fontName` for the first
     run, set `characters`, then per run: `setRangeFontName`, `setRangeFontSize`,
     `setRangeLineHeight` (`{unit:'PIXELS'}` or `AUTO`), `setRangeLetterSpacing`,
     `setRangeFills`, `setRangeTextDecoration`, `setRangeTextCase`.
     `textAutoResize = 'NONE'`, `resize(w, h)`, `textAlignHorizontal`,
     `textAlignVertical = 'TOP'`.
   - Vector: `figma.createNodeFromSvg(svg)`, then `resize(w, h)` and place.
     On failure, fall back to a frame filled with the UI's rasterized backup.
   - Image paint: `{ type: 'IMAGE', imageHash, scaleMode }` with `CROP` using
     the schema transform.
   - Gradient paint: build `gradientTransform` from the unit-square start/end
     (linear) or center/radius (radial) by inverting the affine map that sends
     Figma's default gradient (start (0, 0.5), end (1, 0.5)) onto the requested
     line. Unit-tested against hand-computed values.
4. Yield to the event loop every 50 nodes so progress messages flush and Figma
   stays responsive. Wrap each node build in try/catch: a failed node becomes a
   red-outlined placeholder frame with the error in its name, and import
   continues.
5. `figma.viewport.scrollAndZoomIntoView([root])`, then post the summary.

## 8. Chrome extension

Manifest V3. Permissions: `activeTab`, `scripting`, `downloads`, `storage`,
`clipboardWrite`; `host_permissions: ["<all_urls>"]` so the service worker can
fetch cross-origin images with the extension's origin.

Flow:

1. Popup shows the active tab's title and URL, the options (reveal animations,
   capture video frames), and a Capture button. It warns if the tab is a
   `chrome://` or Web Store page where scripts cannot run.
2. Capture click -> popup sends `start` to the background, which injects
   `content.js` into the tab (main frame) with `chrome.scripting.executeScript`
   and forwards options. The background owns job state in
   `chrome.storage.session` so the popup can close and reopen without killing
   the job.
3. `content.js` runs `capturePage` with an `AssetLoader` that posts
   `fetchAsset { url }` to the background and receives `{ mime, data }` or
   `null`. The background fetches with `credentials: 'include'`, 15 s timeout,
   and caps a single asset at 25 MB.
4. Progress messages from content go to the background, which writes them to
   session storage; the popup renders them.
5. When done, content posts the serialized document string in 4 MB chunks to the
   background, which reassembles it and calls `chrome.downloads.download` with a
   `data:application/json;base64,...` URL named
   `<hostname>-<yyyyMMdd-HHmm>.h2f.json`. The finished JSON is kept in session
   storage while under 5 MB, and the popup then offers a Copy button that
   writes it to the clipboard (a closed popup cannot write the clipboard itself).
6. Errors at any stage are stored on the job and shown in the popup with a
   "copy details" button.

The tab must stay in the foreground during capture (IntersectionObservers and
video decoding do not run in background tabs); the popup states this.

## 9. Error handling summary

- Capture never aborts on a single element: per-element try/catch produces a
  placeholder frame and a warning.
- Asset failures degrade in order: fetch -> canvas draw -> poster -> placeholder.
- Import never aborts on a single node: placeholder frame with the error.
- Missing fonts substitute Inter with a warning listing the original family.
- Both ends surface warnings in their UI and the document keeps `warnings[]`.

## 10. Testing

- `schema`: `validateDocument()` unit tests for version, required fields, run
  coverage.
- `capture` pure modules (Vitest, jsdom): color parsing (hex, rgb, rgba, named,
  and canvas fallback mocked), gradient parsing incl. angle -> start/end math,
  transform matrix decomposition, radius clamping, box-shadow and text-shadow
  parsing, white-space collapsing, font-family selection, naming.
- `capture` integration: fixture pages in `packages/capture/fixtures/` (reveal
  animation, video with and without poster, inline SVG with `currentColor`,
  gradients, shadows, `oklch` backgrounds, fixed header, form controls). A
  Playwright script (`npm run test:browser`) loads each fixture in Chromium,
  injects the built capture bundle, and asserts on the resulting tree
  (e.g. revealed element has `opacity: 1`, video node has an image fill). This
  is a dev dependency and is not required for the unit test run.
- `figma-plugin`: `Builder` tested against a minimal in-memory mock of the
  `figma` global (records created nodes and property sets); gradient transform
  math and font style resolution unit-tested.
- Manual acceptance: capture https://layrd.pro/ at 1440 px wide and import;
  every section must show its content (no blank bands), the header must sit at
  the top, videos must show a still frame.

## 11. Build and install

- `npm install`, `npm run build` -> `packages/extension/dist` and
  `packages/figma-plugin/dist`.
- Chrome: `chrome://extensions`, Developer mode, Load unpacked ->
  `packages/extension/dist`.
- Figma desktop: Plugins -> Development -> Import plugin from manifest ->
  `packages/figma-plugin/dist/manifest.json`.
- `npm run dev` watches both packages.
