import { describe, expect, it } from 'vitest';
import { minLocalInput, snoozeDate } from '../src/mail/snooze';

// Mercredi 10 septembre 2026, 14 h 07 (heure locale).
const now = new Date(2026, 8, 10, 14, 7);

describe('snoozeDate', () => {
  it('plus tard aujourd’hui : trois heures plus tard, au quart d’heure', () => {
    const d = snoozeDate('laterToday', now);
    expect([d.getHours(), d.getMinutes()]).toEqual([17, 15]);
  });

  it('demain à 8 h', () => {
    const d = snoozeDate('tomorrow', now);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([11, 8, 0]);
  });

  it('lundi prochain à 8 h, jamais le jour même', () => {
    expect(snoozeDate('nextWeek', now).getDate()).toBe(14);
    const monday = new Date(2026, 8, 14, 7, 0);
    expect(snoozeDate('nextWeek', monday).getDate()).toBe(21);
  });

  it('minLocalInput', () => {
    expect(minLocalInput(now)).toBe('2026-09-10T14:12');
  });
});
