import { describe, expect, it, vi } from 'vitest';
import { preparePage, shouldForceReveal } from '../src/prepare';

const cs = (over: Partial<CSSStyleDeclaration>) => ({ opacity: '1', transitionProperty: 'all', transitionDuration: '0s', transform: 'none', display: 'block', ...over }) as CSSStyleDeclaration;

describe('shouldForceReveal', () => {
  it('targets opacity-0 elements that animate opacity or carry a reveal transform', () => {
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'all', transitionDuration: '0.6s' }))).toBe(true);
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'opacity, transform', transitionDuration: '0.3s, 0.3s' }))).toBe(true);
    expect(shouldForceReveal(cs({ opacity: '0', transform: 'matrix(1, 0, 0, 1, 0, 24)' }))).toBe(true);
    expect(shouldForceReveal(cs({ opacity: '0' }))).toBe(false);
    expect(shouldForceReveal(cs({ opacity: '0', transitionProperty: 'color', transitionDuration: '1s' }))).toBe(false);
    expect(shouldForceReveal(cs({ opacity: '1', transitionDuration: '1s' }))).toBe(false);
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

  it('does nothing to styles when reveal is disabled', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.body.innerHTML = `<div id="hidden" style="opacity: 0; transition-property: all; transition-duration: 0.6s"></div>`;
    const result = await preparePage(window, document.documentElement, { revealAnimations: false });
    expect(document.getElementById('hidden')!.style.getPropertyValue('opacity')).toBe('0');
    expect(result.warnings).toEqual([]);
  });

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
