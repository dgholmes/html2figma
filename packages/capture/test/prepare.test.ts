import { describe, expect, it, vi } from 'vitest';
import { hasOpacityTransition, preparePage, shouldForceReveal } from '../src/prepare';

const cs = (over: Partial<CSSStyleDeclaration>) => ({ opacity: '1', transitionProperty: 'all', transitionDuration: '0s', transform: 'none', display: 'block', ...over }) as CSSStyleDeclaration;

describe('shouldForceReveal', () => {
  it('targets opacity-0 elements that animate opacity or carry a small reveal-style transform', () => {
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'all', transitionDuration: '0.6s' }))).toBe(true);
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'opacity, transform', transitionDuration: '0.3s, 0.3s' }))).toBe(true);
    expect(shouldForceReveal(cs({ opacity: '0', transform: 'matrix(1, 0, 0, 1, 0, 24)' }))).toBe(true);
    expect(shouldForceReveal(cs({ opacity: '0' }))).toBe(false);
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'color', transitionDuration: '1s' }))).toBe(false);
    expect(shouldForceReveal(cs({ opacity: '1', transitionDuration: '1s' }))).toBe(false);
  });

  // I7 regression: the transform-only trigger previously fired for ANY non-identity transform,
  // which caught the canonical hidden-overlay pattern (a modal/drawer/tooltip/cookie banner
  // centered with `translate(-50%, -50%)`, no opacity transition) as if it were a scroll-reveal
  // target. Bounding it to small translate/scale — the kind real scroll-reveal libraries pair
  // with their opacity animation — excludes that large centering transform.
  it('does not treat a large centering transform (no opacity transition) as a reveal signal', () => {
    // e.g. translate(-50%, -50%) resolved against a ~600px modal: matrix(1, 0, 0, 1, -300, -300)
    // — far outside the ~10%-of-viewport bound real scroll-reveal transforms use.
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'none', transitionDuration: '0s', transform: 'matrix(1, 0, 0, 1, -300, -300)' }))).toBe(false);
  });

  it('does not treat a skew/rotation as a reveal signal even when the translation component is small', () => {
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'none', transitionDuration: '0s', transform: 'matrix(1, 0.5, 0, 1, 0, 0)' }))).toBe(false);
  });

  it('does not treat an out-of-bounds scale as a reveal signal', () => {
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'none', transitionDuration: '0s', transform: 'matrix(3, 0, 0, 3, 0, 0)' }))).toBe(false);
  });
});

describe('hasOpacityTransition', () => {
  it('is true only when transition-property includes opacity or all with a nonzero duration', () => {
    expect(hasOpacityTransition(cs({ transitionProperty: 'all', transitionDuration: '0.6s' }))).toBe(true);
    expect(hasOpacityTransition(cs({ transitionProperty: 'opacity', transitionDuration: '0.3s' }))).toBe(true);
    expect(hasOpacityTransition(cs({ transitionProperty: 'color', transitionDuration: '1s' }))).toBe(false);
    expect(hasOpacityTransition(cs({ transitionProperty: 'all', transitionDuration: '0s' }))).toBe(false);
  });
});

describe('preparePage', () => {
  it('forces reveal styles inline, pauses looping animations, and restores everything', async () => {
    // jsdom does not expand shorthands, so longhands are used here; scrollTo is not implemented in jsdom.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.body.innerHTML = `
      <div id="hidden" style="opacity: 0; transform: translateY(24px); transition-property: all; transition-duration: 0.6s"></div>
      <div id="spinner" style="animation-name: spin; animation-duration: 1s; animation-iteration-count: infinite"></div>
      <img id="lazy" loading="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
    const hidden = document.getElementById('hidden')!;
    const before = hidden.getAttribute('style');
    const stages: string[] = [];
    const result = await preparePage(window, document.documentElement, { revealAnimations: true, onProgress: (s) => stages.push(s) });
    expect(hidden.style.getPropertyValue('opacity')).toBe('1');
    expect(hidden.style.getPropertyValue('transform')).toBe('none');
    expect(document.getElementById('spinner')!.style.getPropertyValue('animation-play-state')).toBe('paused');
    expect(document.getElementById('lazy')!.getAttribute('loading')).toBe('eager');
    expect(result.warnings.some((w) => /Forced 1 scroll-reveal/.test(w))).toBe(true);
    expect(stages).toContain('Scrolling to trigger animations');
    result.restore();
    expect(hidden.getAttribute('style')).toBe(before);
    expect(document.getElementById('spinner')!.style.getPropertyValue('animation-play-state')).toBe('');
  }, 15000);

  // I7 regression: a hidden overlay (opacity: 0, visibility: hidden, a small transform, but no
  // opacity transition) must not be force-revealed into visibility — only opacity/transform get
  // forced (the small-transform signal is weak enough to still act on for those, and 20px is not
  // a relocation concern), but `visibility: hidden` stays untouched so the element still reports
  // `visible: false` in the final capture.
  it('does not force visibility on an element with a small transform but no opacity transition', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    // jsdom does not resolve translateY(20px) into matrix() form for computed style (it echoes
    // the specified value verbatim, same limitation noted in geometry.test.ts), so the already-
    // resolved matrix() form is used directly here — matches translateY(20px).
    document.body.innerHTML = `<div id="tip" style="opacity: 0; visibility: hidden; transform: matrix(1, 0, 0, 1, 0, 20); transition-property: none; transition-duration: 0s"></div>`;
    const tip = document.getElementById('tip')!;
    await preparePage(window, document.documentElement, { revealAnimations: true });
    expect(tip.style.getPropertyValue('opacity')).toBe('1');
    expect(tip.style.getPropertyValue('visibility')).not.toBe('visible');
  }, 15000);

  // I7 regression: a hidden overlay whose only transform is a large centering translate (no
  // opacity transition) must be left alone entirely — not forced visible, not relocated by
  // `transform: none` stripping the centering transform.
  it('leaves a hidden overlay alone when it only carries a large centering transform and no opacity transition', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.body.innerHTML = `<div id="modal" style="opacity: 0; visibility: hidden; transform: matrix(1, 0, 0, 1, -300, -300); transition-property: none; transition-duration: 0s"></div>`;
    const modal = document.getElementById('modal')!;
    const beforeStyle = modal.getAttribute('style');
    const result = await preparePage(window, document.documentElement, { revealAnimations: true });
    // Untouched entirely: shouldForceReveal excludes it (no opacity transition, transform too
    // large to be a reveal signal), so setStyle is never called on it at all.
    expect(modal.getAttribute('style')).toBe(beforeStyle);
    expect(modal.style.getPropertyValue('opacity')).toBe('0');
    expect(modal.getAttribute('style')).toContain('visibility: hidden');
    expect(result.warnings.some((w) => /Forced/.test(w))).toBe(false);
  }, 15000);

  it('does nothing to styles when reveal is disabled', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.body.innerHTML = `<div id="hidden" style="opacity: 0; transition-property: all; transition-duration: 0.6s"></div>`;
    const result = await preparePage(window, document.documentElement, { revealAnimations: false });
    expect(document.getElementById('hidden')!.style.getPropertyValue('opacity')).toBe('0');
    expect(result.warnings).toEqual([]);
  });

  // A page with `scroll-behavior: smooth` turns the final `scrollTo(0, 0)` reset into an async
  // animation, so `win.scrollY` can still be nonzero when geometry is captured right after
  // preparePage returns — which mispositions any position:fixed/sticky element (see prepare.ts).
  // This must hold on BOTH branches: revealAnimations is a real user-facing toggle (the extension
  // popup's "Reveal scroll animations" checkbox), and turning it off still ends in a scroll reset
  // that geometry capture depends on.
  it.each([true, false])('forces instant scrolling (scroll-behavior: auto) on <html> and <body> and restores it afterwards, revealAnimations=%s', async (revealAnimations) => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.documentElement.setAttribute('style', 'scroll-behavior: smooth');
    document.body.innerHTML = '<div id="content"></div>';
    document.body.setAttribute('style', 'scroll-behavior: smooth');
    const beforeHtml = document.documentElement.getAttribute('style');
    const beforeBody = document.body.getAttribute('style');

    const result = await preparePage(window, document.documentElement, { revealAnimations });

    expect(document.documentElement.style.getPropertyValue('scroll-behavior')).toBe('auto');
    expect(document.body.style.getPropertyValue('scroll-behavior')).toBe('auto');

    result.restore();
    expect(document.documentElement.getAttribute('style')).toBe(beforeHtml);
    expect(document.body.getAttribute('style')).toBe(beforeBody);
  }, 15000);

  it('restores forced styles even when preparation throws partway through', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.body.innerHTML = `
      <div id="first" style="opacity: 0; transform: translateY(24px); transition-property: all; transition-duration: 0.6s"></div>
      <div id="second" style="opacity: 0; transform: translateY(24px); transition-property: all; transition-duration: 0.6s"></div>`;
    const first = document.getElementById('first')!;
    const second = document.getElementById('second')!;
    const beforeFirst = first.getAttribute('style');
    const beforeSecond = second.getAttribute('style');
    // The first element (in document order) gets forced visible normally; the second element's
    // getComputedStyle call is made to throw, simulating a pathological/detached element failing
    // mid-scan. preparePage must still undo the mutation it already made to the first element.
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    let calls = 0;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      calls++;
      if (calls === 2) throw new Error('computed style boom');
      return realGetComputedStyle(el);
    });
    await expect(preparePage(window, document.documentElement, { revealAnimations: true })).rejects.toThrow('computed style boom');
    expect(first.getAttribute('style')).toBe(beforeFirst);
    expect(second.getAttribute('style')).toBe(beforeSecond);
    vi.restoreAllMocks();
  }, 15000);
});
