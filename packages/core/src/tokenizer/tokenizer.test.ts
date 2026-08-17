import { beforeAll, describe, expect, it } from 'vitest';
import { countTokens, estimateTokens, initTokenizer, isTokenizerReady, o200k } from './index.js';

// Parity goldens: o200k_base is a fixed BPE, so these counts equal Python's
// tiktoken o200k_base exactly. The ranks are a runtime asset now, so load them
// straight from the package here — still no network.
beforeAll(async () => {
  await initTokenizer(async () => (await import('js-tiktoken/ranks/o200k_base')).default);
  expect(isTokenizerReady()).toBe(true);
});

describe('o200k tokenizer parity', () => {
  const cases: Array<[string, number]> = [
    ['hello world', 2],
    ['The quick brown fox jumps over the lazy dog.', 10],
    ['export function formatPrice(amount: number, currency: string): string {}', 14],
    ['你好，世界', 3],
  ];
  for (const [text, expected] of cases) {
    it(`counts ${JSON.stringify(text)} as ${expected}`, () => {
      expect(countTokens(text)).toBe(expected);
    });
  }

  it('is the canonical o200k_base encoding', () => {
    expect(o200k.name).toBe('o200k_base');
  });

  it('handles the empty string as zero', () => {
    expect(countTokens('')).toBe(0);
    expect(o200k.encode('')).toEqual([]);
  });

  it('encode length agrees with count', () => {
    const s = 'The five boxing wizards jump quickly.';
    expect(o200k.encode(s).length).toBe(countTokens(s));
  });
});

describe('estimateTokens heuristic fallback', () => {
  it('is zero for empty and positive otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
});
