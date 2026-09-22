import { walkNodes, type Node, type TextRun } from '@h2f/schema';

export const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

const WEIGHT_WORDS: [RegExp, number][] = [
  [/\b(hairline|thin)\b/, 100], [/\b(extra|ultra)[\s-]?light\b/, 200], [/\blight\b/, 300], [/\b(regular|normal|book|roman|text)\b/, 400],
  [/\bmedium\b/, 500], [/\b(semi|demi)[\s-]?bold\b/, 600], [/\b(extra|ultra)[\s-]?bold\b/, 800], [/\bbold\b/, 700], [/\b(black|heavy)\b/, 900],
];

export function parseStyleName(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2');
  const spaced = style.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const italic = /\b(italic|oblique)\b/.test(spaced);
  let weight = 400;
  for (const [re, w] of WEIGHT_WORDS) if (re.test(spaced)) { weight = w; break; }
  const num = /\b([1-9]00)\b/.exec(s);
  if (num) weight = parseInt(num[1], 10);
  return { weight, italic };
}

export class FontResolver {
  private readonly families = new Map<string, FontName[]>();
  private readonly loaded = new Map<string, Promise<FontName>>();

  constructor(available: Font[]) {
    for (const f of available) {
      const key = f.fontName.family.toLowerCase();
      const list = this.families.get(key) ?? [];
      list.push(f.fontName);
      this.families.set(key, list);
    }
  }

  resolve(family: string, weight: number, italic: boolean): { fontName: FontName; substituted: boolean } {
    const key = family.trim().replace(/^["']|["']$/g, '').toLowerCase();
    let styles = this.families.get(key);
    let substituted = false;
    if (!styles) { styles = this.families.get(FALLBACK_FONT.family.toLowerCase()) ?? [FALLBACK_FONT]; substituted = true; }
    let best = styles[0];
    let bestScore = Infinity;
    for (const s of styles) {
      const p = parseStyleName(s.style);
      const score = Math.abs(p.weight - weight) + (p.italic === italic ? 0 : 1000);
      if (score < bestScore) { best = s; bestScore = score; }
    }
    return { fontName: best, substituted };
  }

  fontFor(run: Pick<TextRun, 'fontFamily' | 'fontWeight' | 'italic'>): Promise<FontName> {
    const { fontName } = this.resolve(run.fontFamily, run.fontWeight, run.italic);
    const key = `${fontName.family}|${fontName.style}`;
    let p = this.loaded.get(key);
    if (!p) {
      p = figma.loadFontAsync(fontName).then(() => fontName, async () => { await figma.loadFontAsync(FALLBACK_FONT); return FALLBACK_FONT; });
      this.loaded.set(key, p);
    }
    return p;
  }

  async preload(root: Node, warnings: string[]): Promise<void> {
    const seen = new Set<string>();
    const missing = new Set<string>();
    const loads: Promise<FontName>[] = [];
    walkNodes(root, (n) => {
      if (n.type !== 'text') return;
      for (const r of n.runs) {
        const key = `${r.fontFamily}|${r.fontWeight}|${r.italic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.resolve(r.fontFamily, r.fontWeight, r.italic).substituted) missing.add(r.fontFamily);
        loads.push(this.fontFor(r));
      }
    });
    await Promise.all(loads);
    for (const f of missing) warnings.push(`Font "${f}" is not available in Figma; using ${FALLBACK_FONT.family} instead.`);
  }
}
