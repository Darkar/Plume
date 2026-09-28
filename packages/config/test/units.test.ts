import { describe, expect, it } from 'vitest';
import { parseDuration, parseSize } from '../src/units.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['30d', 2_592_000_000],
    [' 5m ', 300_000],
  ])('%s → %d', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '15', 'm', '-5m', '1.5h', '10w', '0m', '15 m', '9999999999d', '1e3s'])(
    'rejette « %s »',
    (input) => {
      expect(parseDuration(input)).toBeNull();
    },
  );
});

describe('parseSize', () => {
  it.each([
    ['1B', 1],
    ['512KB', 512 * 1024],
    ['25MB', 25 * 1024 * 1024],
    ['2GB', 2 * 1024 ** 3],
    ['25mb', 25 * 1024 * 1024],
  ])('%s → %d', (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it.each(['', '25', 'MB', '-1MB', '1.5MB', '1TB', '0MB'])('rejette « %s »', (input) => {
    expect(parseSize(input)).toBeNull();
  });
});
