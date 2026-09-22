export function nameForElement(el: Element, suffix = ''): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const classAttr = el.getAttribute('class') ?? '';
  const classes = classAttr.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('');
  let name = `${tag}${id}${classes}`;
  if (name.length > 60) name = name.slice(0, 60);
  return suffix ? `${name} ${suffix}` : name;
}

export function nameForText(chars: string): string {
  const t = chars.replace(/\s+/g, ' ').trim();
  if (!t) return 'text';
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
