import type { TextNode, TextRun } from '@h2f/schema';
import { BLACK, type ColorFn } from './color';
import { parseLength, splitTopLevel } from './css';
import { unionRect, type Rect } from './geometry';

export function collapseWhitespace(text: string, whiteSpace: string): string {
  if (whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces') return text.replace(/\r\n?/g, '\n');
  if (whiteSpace === 'pre-line') return text.replace(/[ \t\f\r]*\n[ \t\f\r]*/g, '\n').replace(/[ \t\f\r]+/g, ' ');
  return text.replace(/\s+/g, ' ');
}

export function applyTextTransform(text: string, transform: string): string {
  switch (transform) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'capitalize': return text.replace(/(^|\s)(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
    default: return text;
  }
}

export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial',
]);

export function parseFontFamilyList(value: string): string[] {
  return splitTopLevel(value ?? '').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function pickFontFamily(value: string, isAvailable: (family: string) => boolean): string {
  const candidates = parseFontFamilyList(value).filter((f) => !GENERIC_FAMILIES.has(f.toLowerCase()));
  return candidates.find((f) => { try { return isAvailable(f); } catch { return false; } }) ?? candidates[0] ?? 'Inter';
}

export type RunStyle = Omit<TextRun, 'start' | 'end'>;

export function runStyleFromComputed(cs: CSSStyleDeclaration, color: ColorFn, isAvailable: (family: string) => boolean): RunStyle {
  const weightNum = parseInt(cs.fontWeight, 10);
  const fontWeight = Number.isNaN(weightNum) ? (cs.fontWeight === 'bold' || cs.fontWeight === 'bolder' ? 700 : 400) : weightNum;
  const deco = cs.textDecorationLine ?? '';
  return {
    fontFamily: pickFontFamily(cs.fontFamily, isAvailable),
    fontWeight,
    italic: /^(italic|oblique)/.test(cs.fontStyle ?? ''),
    fontSize: parseLength(cs.fontSize) || 16,
    lineHeight: cs.lineHeight === 'normal' || !cs.lineHeight ? null : parseLength(cs.lineHeight),
    letterSpacing: cs.letterSpacing === 'normal' || !cs.letterSpacing ? 0 : parseLength(cs.letterSpacing),
    color: color(cs.color) ?? { ...BLACK },
    decoration: deco.includes('underline') ? 'underline' : deco.includes('line-through') ? 'strikethrough' : 'none',
    textCase: 'original',
  };
}

export function sameRunStyle(a: RunStyle, b: RunStyle): boolean {
  return a.fontFamily === b.fontFamily && a.fontWeight === b.fontWeight && a.italic === b.italic && a.fontSize === b.fontSize
    && a.lineHeight === b.lineHeight && a.letterSpacing === b.letterSpacing && a.decoration === b.decoration && a.textCase === b.textCase
    && a.color.r === b.color.r && a.color.g === b.color.g && a.color.b === b.color.b && a.color.a === b.color.a;
}

export function mapTextAlign(textAlign: string, direction: string): TextNode['align'] {
  const rtl = direction === 'rtl';
  switch (textAlign) {
    case 'center': return 'center';
    case 'right': return 'right';
    case 'justify': return 'justified';
    case 'end': return rtl ? 'left' : 'right';
    case 'start': return rtl ? 'right' : 'left';
    case 'left': return 'left';
    default: return rtl ? 'right' : 'left';
  }
}

export interface TextFragment { text: string; style: RunStyle; rect: Rect | null; whiteSpace: string; isBreak?: boolean }

export function assembleText(fragments: TextFragment[]): { characters: string; runs: TextRun[]; rect: Rect | null } | null {
  let characters = '';
  const runs: TextRun[] = [];
  let rect: Rect | null = null;
  for (const f of fragments) {
    let text = f.isBreak ? '\n' : collapseWhitespace(f.text, f.whiteSpace);
    const preserves = /^pre/.test(f.whiteSpace) || f.whiteSpace === 'break-spaces';
    if (!f.isBreak && !preserves && text.startsWith(' ') && (characters === '' || /\s$/.test(characters))) text = text.slice(1);
    if (text === '') continue;
    const start = characters.length;
    characters += text;
    const end = characters.length;
    const last = runs[runs.length - 1];
    if (last && last.end === start && sameRunStyle(last, f.style)) last.end = end;
    else runs.push({ start, end, ...f.style });
    if (f.rect) rect = rect ? unionRect(rect, f.rect) : { ...f.rect };
  }
  const trimmed = characters.replace(/\s+$/, '');
  if (trimmed.length !== characters.length) {
    characters = trimmed;
    for (const r of runs) r.end = Math.min(r.end, characters.length);
    while (runs.length && runs[runs.length - 1].start >= characters.length) runs.pop();
  }
  if (!characters) return null;
  return { characters, runs, rect };
}
