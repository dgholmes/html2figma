import { describe, expect, it } from 'vitest';
import { countNodes, validateDocument, walkNodes, type FrameNode, type H2FDocument, type TextNode } from '../src/index';

const base = {
  x: 0, y: 0, width: 100, height: 50, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
  fills: [], radius: [0, 0, 0, 0] as [number, number, number, number], effects: [], clip: false,
  meta: { tag: 'div', classes: [] },
};

function text(chars: string, runs: TextNode['runs']): TextNode {
  return { ...base, id: 't1', name: chars, type: 'text', characters: chars, runs, align: 'left', verticalAlign: 'top' };
}

const run = (start: number, end: number) => ({
  start, end, fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 16, lineHeight: 20,
  letterSpacing: 0, color: { r: 0, g: 0, b: 0, a: 1 }, decoration: 'none' as const, textCase: 'original' as const,
});

function doc(children: FrameNode['children'], assets: H2FDocument['assets'] = {}): H2FDocument {
  return {
    version: 1,
    source: { url: 'https://example.com/', title: 'Example', capturedAt: '2026-09-22T00:00:00.000Z', viewport: { width: 1440, height: 900 }, devicePixelRatio: 1, userAgent: 'test', fullPageHeight: 2000 },
    root: { ...base, id: 'root', name: 'html', type: 'frame', width: 1440, height: 2000, children },
    assets,
    warnings: [],
  };
}

describe('validateDocument', () => {
  it('accepts a minimal valid document', () => {
    const result = validateDocument(doc([text('Hi', [run(0, 2)])]));
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong version', () => {
    const result = validateDocument({ ...doc([]), version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/version/);
  });

  it('rejects text runs that do not cover the characters', () => {
    const result = validateDocument(doc([text('Hello', [run(0, 2), run(3, 5)])]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/runs/);
  });

  it('rejects image paints and vectors that reference missing assets', () => {
    const withImage: FrameNode = { ...base, id: 'f', name: 'img', type: 'frame', children: [], fills: [{ type: 'image', assetId: 'nope', scaleMode: 'fill' }] };
    const result = validateDocument(doc([withImage]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/asset "nope"/);
  });

  it('accepts referenced assets', () => {
    const withImage: FrameNode = { ...base, id: 'f', name: 'img', type: 'frame', children: [], fills: [{ type: 'image', assetId: 'a1', scaleMode: 'fill' }] };
    const result = validateDocument(doc([withImage], { a1: { id: 'a1', kind: 'image', mime: 'image/png', data: 'AAAA', width: 1, height: 1, origin: 'img' } }));
    expect(result.ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateDocument(null).ok).toBe(false);
    expect(validateDocument('x').ok).toBe(false);
  });
});

describe('walkNodes / countNodes', () => {
  it('visits every node depth-first and counts them', () => {
    const inner: FrameNode = { ...base, id: 'f', name: 'f', type: 'frame', children: [text('a', [run(0, 1)])] };
    const d = doc([inner, text('b', [run(0, 1)])]);
    const seen: string[] = [];
    walkNodes(d.root, (n, depth) => seen.push(`${n.id}@${depth}`));
    expect(seen).toEqual(['root@0', 'f@1', 't1@2', 't1@1']);
    expect(countNodes(d.root)).toBe(4);
  });
});
