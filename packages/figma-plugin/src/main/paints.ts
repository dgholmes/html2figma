import type { Effect as H2FEffect, Paint as H2FPaint, Point, RGBA } from '@h2f/schema';

export function invertTransform(t: Transform): Transform {
  const [[a, b, tx], [c, d, ty]] = t;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [[1, 0, 0], [0, 1, 0]];
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [[ia, ib, -(ia * tx + ib * ty)], [ic, id, -(ic * tx + id * ty)]];
}

export function gradientTransformForLine(start: Point, end: Point): Transform {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return [[1, 0, 0], [0, 1, 0]];
  return invertTransform([[dx, -dy, start.x + dy / 2], [dy, dx, start.y - dx / 2]]);
}

export function gradientTransformForRadial(center: Point, radius: Point): Transform {
  const rx = radius.x || 0.5;
  const ry = radius.y || 0.5;
  return invertTransform([[2 * rx, 0, center.x - rx], [0, 2 * ry, center.y - ry]]);
}

export function gradientTransformForAngular(center: Point, angleDeg: number): Transform {
  const r = ((angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return invertTransform([[cos, -sin, center.x - 0.5 * cos + 0.5 * sin], [sin, cos, center.y - 0.5 * sin - 0.5 * cos]]);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export function toFigmaColor(c: RGBA): { color: RGB; opacity: number } {
  return { color: { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) }, opacity: clamp01(c.a) };
}

export function toFigmaPaint(paint: H2FPaint, images: Map<string, string>): Paint | null {
  switch (paint.type) {
    case 'solid': {
      const { color, opacity } = toFigmaColor(paint.color);
      return { type: 'SOLID', color, opacity };
    }
    case 'gradient': {
      const gradientStops: ColorStop[] = paint.stops.map((s) => ({ position: clamp01(s.position), color: { ...toFigmaColor(s.color).color, a: clamp01(s.color.a) } }));
      const center = paint.center ?? { x: 0.5, y: 0.5 };
      if (paint.gradient === 'linear') return { type: 'GRADIENT_LINEAR', gradientTransform: gradientTransformForLine(paint.start, paint.end), gradientStops };
      if (paint.gradient === 'radial') return { type: 'GRADIENT_RADIAL', gradientTransform: gradientTransformForRadial(center, paint.radius ?? { x: 0.5, y: 0.5 }), gradientStops };
      const angle = (Math.atan2(paint.end.x - center.x, -(paint.end.y - center.y)) * 180) / Math.PI;
      return { type: 'GRADIENT_ANGULAR', gradientTransform: gradientTransformForAngular(center, angle), gradientStops };
    }
    case 'image': {
      const imageHash = images.get(paint.assetId);
      if (!imageHash) return null;
      const opacity = paint.opacity ?? 1;
      switch (paint.scaleMode) {
        case 'fill': return { type: 'IMAGE', imageHash, scaleMode: 'FILL', opacity };
        case 'fit': return { type: 'IMAGE', imageHash, scaleMode: 'FIT', opacity };
        case 'tile': return { type: 'IMAGE', imageHash, scaleMode: 'TILE', scalingFactor: paint.scale ?? 1, opacity };
        case 'crop': return { type: 'IMAGE', imageHash, scaleMode: 'CROP', imageTransform: paint.transform ?? [[1, 0, 0], [0, 1, 0]], opacity };
      }
    }
  }
  return null;
}

export function toFigmaEffects(effects: H2FEffect[]): Effect[] {
  return effects.map((e): Effect => {
    // Switch (rather than `if (e.type === 'a' || e.type === 'b')`) because TS 7.0.2's
    // control-flow analysis does not narrow away both arms of an OR'd discriminant
    // check on this union (confirmed via a minimal repro); a fallthrough switch does.
    switch (e.type) {
      case 'drop-shadow':
      case 'inner-shadow': {
        const { color } = toFigmaColor(e.color);
        return { type: e.type === 'drop-shadow' ? 'DROP_SHADOW' : 'INNER_SHADOW', color: { ...color, a: clamp01(e.color.a) }, offset: e.offset, radius: Math.max(0, e.blur), spread: e.spread, visible: true, blendMode: 'NORMAL' };
      }
      default:
        return { type: e.type === 'layer-blur' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: Math.max(0, e.radius), visible: true } as Effect;
    }
  });
}

const BLEND: Record<string, BlendMode> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

// I6: a CSS `normal` blend mode (the default — explicit or inherited) means "just paint through",
// which on a Figma frame/group is `PASS_THROUGH`, not `NORMAL`. `NORMAL` creates an isolated
// blending group, so mapping every node's default blend mode to it made every DOM element (which
// all become frames) an isolation boundary — a descendant with e.g. `mix-blend-mode: difference`
// then blended only against its immediate parent instead of the real ancestor background,
// rendering opaque instead of inverted. `allowPassThrough` is only passed `true` for container
// nodes (frames, svg-wrapper frames) that don't otherwise isolate (opacity 1, no blur effect);
// text/vector leaves and isolating containers keep the direct NORMAL mapping.
export function toFigmaBlendMode(css: string, allowPassThrough = false): BlendMode {
  if (allowPassThrough && (css === 'normal' || !(css in BLEND))) return 'PASS_THROUGH' as BlendMode;
  return BLEND[css] ?? 'NORMAL';
}
