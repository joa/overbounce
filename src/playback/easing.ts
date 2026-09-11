/**
 * Easing curves for timeline keyframes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## The shape comes from the picker, not from a list of names
 *
 * `design/Overbounce Playback.dc.html`'s `Pc` draws easing as **two
 * controls**: a direction (LINEAR / IN / OUT / EASE) beside a curve family
 * (QUAD / CUBIC / BOUNCE). So that is what an `Ease` is here -- a pair --
 * rather than a flat `'ease-in-cubic'` string that the UI would have to
 * parse back apart to light up two buttons, and re-join to store. The data
 * model matching the control is what keeps the picker from needing a
 * translation layer in both directions.
 *
 * Two consequences the design states and this enforces:
 *
 *  - **A direction alone is meaningless.** IN what? Picking a direction with
 *    no family pairs one automatically (`withDirection`), which is the
 *    behaviour the mockup describes.
 *  - **LINEAR has no family.** It ignores whatever family is set rather than
 *    erroring, so switching LINEAR -> OUT and back does not lose the family
 *    the user had chosen.
 *
 * ## The families
 *
 * QUAD, CUBIC and BOUNCE are the three the design exposes. `sine`, `expo`
 * and `back` are implemented alongside them because they cost four lines
 * each and are what a cinematic camera move usually wants -- but they are
 * **engine-supported and not exposed by the picker**, deliberately: the
 * design chose three, and a control with six families in it is a different
 * design decision, not an implementation detail. Anything constructing an
 * `Ease` in code may use them; `PICKER_FAMILIES` is what the UI offers.
 *
 * Everything here is a pure function of `t` in `[0, 1]`. No `three`, no DOM,
 * no time source.
 */

/** Which way the curve leans. */
export type EaseDirection = 'linear' | 'in' | 'out' | 'ease';

/** Which curve. `ease` here means the symmetric in-out of that family. */
export type EaseFamily = 'quad' | 'cubic' | 'bounce' | 'sine' | 'expo' | 'back';

export interface Ease {
  direction: EaseDirection;
  family: EaseFamily;
}

/** What `Pc`'s picker offers. See the file header for why it is a subset. */
export const PICKER_FAMILIES: readonly EaseFamily[] = ['quad', 'cubic', 'bounce'];
export const PICKER_DIRECTIONS: readonly EaseDirection[] = ['linear', 'in', 'out', 'ease'];

/**
 * The default a fresh keyframe gets.
 *
 * LINEAR, because a keyframe that quietly curves is a keyframe whose motion
 * the user did not ask for -- easing is something you reach for, not
 * something that happens to you.
 */
export const DEFAULT_EASE: Ease = { direction: 'linear', family: 'cubic' };

/**
 * Change the direction, pairing a family when one is needed.
 *
 * `Pc`: "direction alone is meaningless, so picking OUT auto-pairs a family
 * (e.g. Ease Out Cubic)". The family already on the ease is kept if there is
 * one; otherwise CUBIC, which is the least surprising default and the one the
 * mockup names.
 */
export function withDirection(ease: Ease, direction: EaseDirection): Ease {
  return { direction, family: ease.family || 'cubic' };
}

/** Change the family, keeping the direction. LINEAR is promoted to EASE,
 *  since choosing a curve while LINEAR would otherwise do nothing visible. */
export function withFamily(ease: Ease, family: EaseFamily): Ease {
  return { direction: ease.direction === 'linear' ? 'ease' : ease.direction, family };
}

/** A human label, for the picker's summary line: "Ease Out Cubic". */
export function easeLabel(ease: Ease): string {
  if (ease.direction === 'linear') {
    return 'Linear';
  }
  const family = ease.family.charAt(0).toUpperCase() + ease.family.slice(1);
  if (ease.direction === 'ease') {
    return `Ease In Out ${family}`;
  }
  return `Ease ${ease.direction === 'in' ? 'In' : 'Out'} ${family}`;
}

/** The `in` curve of each family: slow start, fast finish. */
const EASE_IN: Record<EaseFamily, (t: number) => number> = {
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  expo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  back: (t) => {
    // The overshoot constants are the CSS/Penner ones: c3 = c1 + 1 with
    // c1 = 1.70158, which is the value that gives roughly 10% overshoot.
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
  bounce: (t) => 1 - bounceOut(1 - t),
};

/**
 * `bounce`'s out curve, which is the one the family is actually defined by --
 * the others are derived from it by reflection.
 *
 * The four-segment piecewise form with n1 = 7.5625 and d1 = 2.75 is the
 * standard one (Penner, and what every CSS easing library ships); the
 * constants are not tunable knobs, they are what makes the segments meet
 * with matching slopes.
 */
function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  }
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

/**
 * Apply an ease to a normalized `t`.
 *
 * `out` is `in` reflected through the diagonal; `ease` (in-out) is the two
 * halves stitched. Deriving both from one curve per family rather than
 * writing three is what keeps them consistent -- an `out` that is not the
 * exact mirror of its `in` reads as two different curves wearing one name.
 *
 * `t` outside `[0, 1]` is clamped: a keyframe segment is a closed interval,
 * and letting `back`'s overshoot formula run at t = 3 produces numbers no
 * camera should visit.
 */
export function applyEase(ease: Ease, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (ease.direction === 'linear') {
    return x;
  }
  const fn = EASE_IN[ease.family] ?? EASE_IN.cubic;
  if (ease.direction === 'in') {
    return fn(x);
  }
  if (ease.direction === 'out') {
    return 1 - fn(1 - x);
  }
  // 'ease' -- symmetric in-out.
  return x < 0.5 ? fn(x * 2) / 2 : 1 - fn((1 - x) * 2) / 2;
}
