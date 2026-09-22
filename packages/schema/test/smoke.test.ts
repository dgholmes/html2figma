import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/index';

describe('schema package', () => {
  it('exports schema version 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
