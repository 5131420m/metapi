import { describe, expect, it } from 'vitest';

import {
  areModelRouteAliasesEquivalent,
  normalizeDiscoveredModelNames,
  normalizeFullSourceModelName,
  normalizeModelRouteName,
} from './modelName.js';

describe('model route names', () => {
  it.each([
    ['BBB', 'bbb'],
    ['Bbb', 'bbb'],
    ['AAA/BBB', 'bbb'],
    ['AAA/CCC/BBB', 'bbb'],
    [' AAA/BBB ', 'bbb'],
    ['AAA/', 'aaa/'],
    ['', ''],
  ])('normalizes %j to canonical route %j', (input, expected) => {
    expect(normalizeModelRouteName(input)).toBe(expected);
  });

  it('treats namespaced and plain model names as route aliases', () => {
    expect(areModelRouteAliasesEquivalent('AAA/BBB', 'bbb')).toBe(true);
    expect(areModelRouteAliasesEquivalent('AAA/BBB', 'CCC/BBB')).toBe(true);
    expect(areModelRouteAliasesEquivalent('AAA/BBB', 'CCC/DDD')).toBe(false);
  });

  it('keeps case-distinct full model names while removing exact duplicates after trimming', () => {
    expect(normalizeDiscoveredModelNames([
      ' glm-5.2 ',
      'GLM-5.2',
      'glm-5.2',
      'AAA/GLM-5.2',
      '',
    ])).toEqual(['glm-5.2', 'GLM-5.2', 'AAA/GLM-5.2']);
  });

  it('trims full source identities without folding case or discarding namespaces', () => {
    expect(normalizeFullSourceModelName(' AAA/Bbb ')).toBe('AAA/Bbb');
    expect(normalizeFullSourceModelName('BBB')).toBe('BBB');
    expect(normalizeFullSourceModelName('bbb')).toBe('bbb');
  });
});
