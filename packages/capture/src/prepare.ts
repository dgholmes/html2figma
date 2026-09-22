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

export async function preparePage(win: Window, root: Element, opts: { revealAnimations: boolean; onProgress?: ProgressFn }): Promise<{ warnings: string[]; restore: () => void }> {
  const doc = win.document;
  const warnings: string[] = [];
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
    } else {
      win.scrollTo(0, 0);
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
  await nextFrame(win);

  return { warnings, restore };
}
