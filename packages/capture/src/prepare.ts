import { decomposeMatrix, isIdentityMatrix, parseMatrix } from './css';

export type ProgressFn = (stage: string, done: number, total: number) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = (win: Window) => new Promise<void>((r) => (win.requestAnimationFrame ? win.requestAnimationFrame(() => r()) : setTimeout(r, 16)));

export interface Viewport { width: number; height: number }
const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

// I7: the spec's force-reveal trigger is "opacity: 0 AND transition-property includes opacity or
// all". Exposed separately from shouldForceReveal so the caller (the force-reveal scan below) can
// also use it to decide whether it's safe to force `visibility: visible`, not just whether to
// force at all.
//
// Reconciling "27" vs "25": README.md and layrd.mjs describe layrd.pro as hiding "~27" scroll-
// reveal sections/blocks — an approximate, content-level description of the site's design, not a
// claim about how many individual DOM elements shouldForceReveal matches. Measured directly on
// the live site (same scroll-and-settle sequence this function runs, both the old unbounded
// transform check and this bounded one evaluated side by side against the identical settled DOM
// state): both match exactly the same 25 elements — zero lost by the I7 narrowing, zero gained.
// None of the 25 actually carry a CSS `transition-property` matching this function's own
// `hasOpacityTransition` check at all (layrd.pro's reveal is driven by a JS animation library
// that writes `opacity`/`transform` inline per frame — see the REVEAL_SETTLE_MS comment below —
// not by a declared CSS `transition`), so every one of them is, and always was, matched solely
// through the transform-based signal; narrowing that signal's bounds did not drop any of them.
// "25" is simply the real, current count of matched DOM elements; "27" was only ever an
// approximate content-level figure from the original investigation, not a target this function's
// own count needs to hit.
export function hasOpacityTransition(cs: CSSStyleDeclaration): boolean {
  const props = (cs.transitionProperty || '').split(',').map((p) => p.trim());
  const durations = (cs.transitionDuration || '0s').split(',').map((d) => parseFloat(d) || 0);
  return props.some((p, i) => (p === 'all' || p === 'opacity') && (durations[i] ?? durations[durations.length - 1] ?? 0) > 0);
}

// A small translate/scale, of the kind scroll-reveal libraries pair with their opacity animation
// (see the design spec: "opacity: 0 plus a small translate/scale"), used as a secondary signal
// when there's no declared opacity transition to go on. Bounded to translations under ~10% of the
// viewport and scale within 0.5–1.5 so it can't be satisfied by an unrelated large transform, e.g.
// a `translate(-50%, -50%)` centering a modal (which, resolved against a typical modal's own
// size, is easily hundreds of pixels — far outside this bound).
function hasSmallRevealTransform(cs: CSSStyleDeclaration, viewport: Viewport): boolean {
  const m = parseMatrix(cs.transform);
  if (!m || isIdentityMatrix(m)) return false;
  const d = decomposeMatrix(m);
  if (d.skewed) return false;
  const scaleOk = d.scaleX >= 0.5 && d.scaleX <= 1.5 && d.scaleY >= 0.5 && d.scaleY <= 1.5;
  const translateOk = Math.abs(m.e) <= viewport.width * 0.1 && Math.abs(m.f) <= viewport.height * 0.1;
  return scaleOk && translateOk;
}

export function shouldForceReveal(cs: CSSStyleDeclaration, viewport: Viewport = DEFAULT_VIEWPORT): boolean {
  if (cs.display === 'none' || parseFloat(cs.opacity || '1') > 0.001) return false;
  return hasOpacityTransition(cs) || hasSmallRevealTransform(cs, viewport);
}

// Minimum real time to guarantee has elapsed since the scroll-reset before scanning for elements
// still needing to be forced visible. Some sites run their own reverse "un-reveal" animation the
// instant we scroll away from an element that was only shown because it was in view — a JS
// tween driven by its own internal timeline (not by reading the DOM's current opacity back), so
// forcing an element mid-tween is immediately overwritten by that tween's very next frame. On
// layrd.pro this reverse animation was observed to take ~750ms–1.15s from the scrollTo(0, 0)
// reset to fully settle back to hidden; 2000ms leaves comfortable margin. This must not be
// conflated with the font/image-loading wait later in this function — that wait's duration is
// unpredictable (near-instant when assets are already cached, as on a page revisited or one with
// few remote assets) and cannot be relied on to also cover this settle time.
const REVEAL_SETTLE_MS = 2000;

export async function preparePage(win: Window, root: Element, opts: { revealAnimations: boolean; onProgress?: ProgressFn }): Promise<{ warnings: string[]; restore: () => void }> {
  const doc = win.document;
  const warnings: string[] = [];
  let resetAt = 0;
  const touched: { el: HTMLElement; style: string | null }[] = [];
  const loadingRestores: { img: HTMLImageElement; value: string }[] = [];
  const setStyle = (el: HTMLElement, css: Record<string, string>) => {
    touched.push({ el, style: el.getAttribute('style') });
    for (const [k, v] of Object.entries(css)) el.style.setProperty(k, v, 'important');
  };
  // Built before any mutation happens so a throw partway through the reveal/animation-pause work
  // below (e.g. getComputedStyle or setProperty failing on a pathological or detached element
  // during the multi-second scroll sequence) can still be undone from the catch block: without
  // this, an exception would abort the function before its `return` ever hands a restore function
  // back to the caller, leaving every already-forced style stuck on the live page.
  const restore = () => {
    for (const t of touched.reverse()) {
      if (t.style === null) t.el.removeAttribute('style'); else t.el.setAttribute('style', t.style);
    }
    for (const r of loadingRestores) r.img.setAttribute('loading', r.value);
  };

  try {
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[loading="lazy"]'))) {
      loadingRestores.push({ img, value: img.getAttribute('loading') ?? '' });
      img.setAttribute('loading', 'eager');
    }

    // A page with `scroll-behavior: smooth` on <html> (or <body>, when it's the actual
    // scrolling element) turns every `scrollTo` below into an async animation instead of an
    // instant jump. A `scrollTo(0, 0)` reset would then still be mid-animation — scrollY
    // nonzero — when geometry is captured a few lines down. That's invisible for normally-
    // flowing elements (getBoundingClientRect + scrollY is scroll-invariant for them), but a
    // `position: fixed` (or `sticky`) element's rect is already viewport-relative, so adding a
    // leftover nonzero scrollY shifts it away from its true position. This applies whether or
    // not scroll-reveal animations are being triggered below — the `revealAnimations: false`
    // path also ends in a `scrollTo(0, 0)` that geometry capture depends on — so force instant
    // scrolling unconditionally, before the branch. `restore()` undoes it below.
    setStyle(doc.documentElement, { 'scroll-behavior': 'auto' });
    if (doc.body) setStyle(doc.body, { 'scroll-behavior': 'auto' });

    if (opts.revealAnimations) {
      const total = Math.max(doc.documentElement.scrollHeight, 1);
      const step = Math.max(200, Math.floor((win.innerHeight || 800) * 0.8));
      for (let y = 0; y <= total; y += step) {
        win.scrollTo(0, y);
        opts.onProgress?.('Scrolling to trigger animations', Math.min(y, total), total);
        await sleep(120);
      }
      await sleep(1500);
      win.scrollTo(0, 0);
      await nextFrame(win);
      await sleep(300);
      resetAt = Date.now();
    } else {
      win.scrollTo(0, 0);
      await nextFrame(win);
    }
  } catch (e) {
    restore();
    throw e;
  }

  for (const v of Array.from(doc.querySelectorAll('video'))) { try { v.pause(); } catch { /* ignore */ } }

  opts.onProgress?.('Waiting for fonts and images', 0, 1);
  try { await Promise.race([doc.fonts?.ready ?? Promise.resolve(), sleep(3000)]); } catch { /* ignore */ }
  const pending = Array.from(root.querySelectorAll('img')).filter((i) => !i.complete);
  if (pending.length) {
    const all = Promise.all(pending.map((i) => new Promise<void>((res) => { i.addEventListener('load', () => res(), { once: true }); i.addEventListener('error', () => res(), { once: true }); })));
    await Promise.race([all, sleep(8000)]);
    if (pending.some((i) => !i.complete)) warnings.push(`${pending.filter((i) => !i.complete).length} image(s) were still loading when capture started.`);
  }

  // The force-reveal scan runs LAST — after the font/image waits above, AND after guaranteeing
  // REVEAL_SETTLE_MS has passed since the scroll-reset — not right after the scroll-reset itself.
  // Caught live on layrd.pro: some elements run their own reverse "un-reveal" tween the instant
  // we scroll away, driven by the tween's own internal timeline rather than by reading the DOM's
  // current opacity back. An element observed at opacity 1 right after the scroll-reset had
  // decayed back to its original opacity 0 about a second later, because that tween was still
  // easing back toward its "not revealed here" resting state and simply overwrote our forced
  // value on its next frame — our `!important` inline declaration doesn't help, because the
  // tween's own `el.style.opacity = …` write replaces the whole stored inline declaration
  // outright, `!important` or not. Forcing right after the scroll-reset (the original behavior)
  // raced that tween and sometimes lost. Waiting for the font/image loads AND, on top of that,
  // for REVEAL_SETTLE_MS of real time since the reset (the font/image wait alone isn't reliable
  // for this: it can resolve near-instantly when assets are already cached, well before a
  // reverse tween has had time to finish) means we scan only once any such tween has already run
  // its course and gone idle, so nothing is left to un-force it before the walk reads computed
  // style moments later.
  if (opts.revealAnimations) {
    const elapsedSinceReset = Date.now() - resetAt;
    if (elapsedSinceReset < REVEAL_SETTLE_MS) await sleep(REVEAL_SETTLE_MS - elapsedSinceReset);
    try {
      let forced = 0;
      const viewport: Viewport = { width: win.innerWidth || DEFAULT_VIEWPORT.width, height: win.innerHeight || DEFAULT_VIEWPORT.height };
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('body *'))) {
        const cs = win.getComputedStyle(el);
        if (shouldForceReveal(cs, viewport)) {
          const forcedStyle: Record<string, string> = { opacity: '1', transform: 'none', transition: 'none', animation: 'none' };
          // Only force `visibility: visible` when there's an actual opacity transition — the
          // spec's own trigger. Without one, this element was only caught by the bounded
          // small-transform signal, which is a weaker sign of a scroll-reveal target; an
          // element that's also `visibility: hidden` (the canonical modal/drawer/tooltip/cookie
          // banner pattern) stays hidden rather than being dragged into the capture.
          if (hasOpacityTransition(cs)) forcedStyle.visibility = 'visible';
          setStyle(el, forcedStyle);
          forced++;
        } else if (cs.animationName && cs.animationName !== 'none' && /infinite/.test(cs.animationIterationCount || '')) {
          setStyle(el, { 'animation-play-state': 'paused' });
        }
      }
      if (forced) warnings.push(`Forced ${forced} scroll-reveal element(s) to their visible state.`);
    } catch (e) {
      restore();
      throw e;
    }
  }

  await nextFrame(win);

  return { warnings, restore };
}
