import { describe, expect, it } from 'vitest';
import { resetViewYaw } from '../../src/game/view-reset.js';

const Y_LOCK = { axis: 1 as const };
const X_LOCK = { axis: 0 as const };

describe('resetViewYaw', () => {
  it('turns a y-locked player to +X when that is nearer', () => {
    expect(resetViewYaw(0, Y_LOCK, 0)).toBe(0);
    expect(resetViewYaw(35, Y_LOCK, 0)).toBe(0);
    expect(resetViewYaw(-80, Y_LOCK, 0)).toBe(0);
    expect(resetViewYaw(300, Y_LOCK, 0)).toBe(0);
  });

  it('turns a y-locked player running toward -X back along -X', () => {
    expect(resetViewYaw(180, Y_LOCK, 0)).toBe(180);
    expect(resetViewYaw(120, Y_LOCK, 0)).toBe(180);
    expect(resetViewYaw(-120, Y_LOCK, 0)).toBe(180);
  });

  it('breaks an exact 90-degree tie toward +X, the spawn facing of every course', () => {
    expect(resetViewYaw(90, Y_LOCK, 0)).toBe(0);
    expect(resetViewYaw(270, Y_LOCK, 0)).toBe(0);
  });

  it('handles an accumulated yaw that has wound past 360 either way', () => {
    expect(resetViewYaw(725, Y_LOCK, 0)).toBe(0);
    expect(resetViewYaw(-900, Y_LOCK, 0)).toBe(180);
  });

  it('uses 90 or 270 on an x lock', () => {
    expect(resetViewYaw(60, X_LOCK, 0)).toBe(90);
    expect(resetViewYaw(250, X_LOCK, 0)).toBe(270);
  });

  it('falls back to the spawn facing with no scroll axis', () => {
    expect(resetViewYaw(123, null, 45)).toBe(45);
    expect(resetViewYaw(123, { axis: 2 }, -90)).toBe(270);
  });
});
