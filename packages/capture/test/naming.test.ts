import { describe, expect, it } from 'vitest';
import { nameForElement, nameForText } from '../src/naming';

describe('nameForElement', () => {
  it('uses tag, id, and at most two classes', () => {
    const el = document.createElement('section');
    el.id = 'hero';
    el.className = 'v13-hero dark  wide';
    expect(nameForElement(el)).toBe('section#hero.v13-hero.dark');
    expect(nameForElement(document.createElement('div'))).toBe('div');
  });
  it('truncates long names and appends suffixes', () => {
    const el = document.createElement('div');
    el.className = 'a'.repeat(80);
    expect(nameForElement(el).length).toBe(60);
    expect(nameForElement(document.createElement('img'), '(video)')).toBe('img (video)');
  });
  it('handles svg elements whose className is an object', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon big');
    expect(nameForElement(svg)).toBe('svg.icon.big');
  });
});

describe('nameForText', () => {
  it('collapses whitespace and truncates', () => {
    expect(nameForText('  Make   your\nphotos ')).toBe('Make your photos');
    expect(nameForText('x'.repeat(50))).toBe('x'.repeat(40) + '…');
    expect(nameForText('   ')).toBe('text');
  });
});
