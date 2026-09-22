export type ProgressFn = (stage: string, done: number, total: number) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = (win: Window) => new Promise<void>((r) => (win.requestAnimationFrame ? win.requestAnimationFrame(() => r()) : setTimeout(r, 16)));

export function shouldForceReveal(cs: CSSStyleDeclaration): boolean {
  if (cs.display === 'none' || parseFloat(cs.opacity || '1') > 0.001) return false;
  const props = (cs.transitionProperty || '').split(',').map((p) => p.trim());
  const durations = (cs.transitionDuration || '0s').split(',').map((d) => parseFloat(d) || 0);
  const animatesOpacity = props.some((p, i) => (p === 'all' || p === 'opacity') && (durations[i] ?? durations[durations.length - 1] ?? 0) > 0);
  const hasRevealTransform = !!cs.transform && cs.transform !== 'none' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)';
  return animatesOpacity || hasRevealTransform;
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
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('body *'))) {
        const cs = win.getComputedStyle(el);
        if (shouldForceReveal(cs)) {
          setStyle(el, { opacity: '1', transform: 'none', visibility: 'visible', transition: 'none', animation: 'none' });
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
