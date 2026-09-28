import { describe, expect, it } from 'vitest';
import '../src/viewer/polyfills';

describe('polyfills de la visionneuse PDF', () => {
  it('Map.getOrInsertComputed ne calcule la valeur qu’une fois', () => {
    const map = new Map<string, number[]>();
    let calls = 0;
    const make = () => {
      calls++;
      return [];
    };
    (map as unknown as { getOrInsertComputed: (k: string, f: () => number[]) => number[] })
      .getOrInsertComputed('a', make)
      .push(1);
    const again = (
      map as unknown as { getOrInsertComputed: (k: string, f: () => number[]) => number[] }
    ).getOrInsertComputed('a', make);
    expect(again).toEqual([1]);
    expect(calls).toBe(1);
  });

  it('WeakMap.getOrInsert conserve la valeur existante', () => {
    const key = {};
    const map = new WeakMap<object, string>([[key, 'x']]);
    const upsert = map as unknown as { getOrInsert: (k: object, v: string) => string };
    expect(upsert.getOrInsert(key, 'y')).toBe('x');
    expect(upsert.getOrInsert({}, 'z')).toBe('z');
  });
});
