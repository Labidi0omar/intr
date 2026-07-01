import { coachTintFor } from './coachTint';
import type { TrainingStatusState } from './trainingStatus';

describe('coachTintFor', () => {
  test('recovering_well → bright teal tint + teal glow', () => {
    const t = coachTintFor('recovering_well');
    expect(t.tint).toBe('#0EA5E9');
    expect(t.glow).toBe('#0EA5E9');
  });

  test('holding_steady → neutral warm white tint + amber glow', () => {
    const t = coachTintFor('holding_steady');
    expect(t.tint).toBe('#FFFFFF');
    expect(t.glow).toBe('#F59E0B');
  });

  test('backing_off → cool indigo (NOT red — red is destructive-only)', () => {
    const t = coachTintFor('backing_off');
    expect(t.tint).toBe('#818CF8');
    expect(t.glow).toBe('#818CF8');
    // The mapping must never return the destructive red token.
    expect(t.tint).not.toBe('#EF4444');
    expect(t.glow).not.toBe('#EF4444');
  });

  test('unknown → neutral slate, no warm/cool bias', () => {
    const t = coachTintFor('unknown');
    expect(t.tint).toBe('#94A3B8');
    expect(t.glow).toBe('#94A3B8');
  });

  test('every state returns non-empty hex tint + glow', () => {
    const states: TrainingStatusState[] = [
      'recovering_well',
      'holding_steady',
      'backing_off',
      'unknown',
    ];
    for (const s of states) {
      const t = coachTintFor(s);
      expect(t.tint).toMatch(/^#[0-9A-F]{6}$/);
      expect(t.glow).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  test('pure: same input → same output', () => {
    expect(coachTintFor('recovering_well')).toEqual(coachTintFor('recovering_well'));
    expect(coachTintFor('backing_off')).toEqual(coachTintFor('backing_off'));
  });
});
