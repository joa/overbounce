/**
 * A settings change is remembered, whichever door the screen was opened from.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * @vitest-environment happy-dom
 *
 * This is the regression test for a bug that shipped and was invisible.
 * `applyHudSetting` used to be:
 *
 *     if (liveApply) { liveApply(); } else { settings.set(key, value); … }
 *
 * — the live callback INSTEAD of the write, on the reasoning that every live
 * callback persists on its own. True for the door it was written against (a
 * running course, whose callbacks all end in `applyQuickSetting`) and silently
 * false for the other one: `main.ts` opens this same screen over PLAYBACK and
 * passes `() => {}` for every row that has nothing to apply to a recording, so
 * the write went to the no-op and the change was dropped.
 *
 * Six rows were affected — obhelp, ghost, debugpanel, strafegauge,
 * strafehelper, crosshair — and the failure looked like a broken toggle rather
 * than a lost write, because the panel re-renders from storage and the control
 * snapped straight back.
 *
 * So the case that matters here is **a `live` context whose callbacks do
 * nothing**. That is the playback door exactly, and it is the shape a browser
 * check on the title screen cannot reach: with no course running `live` is
 * undefined, which took the `else` branch and worked even before the fix.
 * Every assertion below fails against the old code.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { showSettingsScreen } from '../../src/ui/screens/settings.js';
import type { SettingsLiveCallbacks } from '../../src/ui/screens/settings.js';

const KEY = 'overbounce.settings.v1';

/**
 * The playback door: every callback present, every one of them a no-op.
 *
 * Deliberately not a spy — the point is not that the callback ran, it is that
 * storage was written even though the callback did nothing at all.
 */
function noopLive(): SettingsLiveCallbacks {
  return {
    onObHelpChange: () => {},
    onGhostToggle: () => {},
    onDebugToggle: () => {},
    onStrafeGaugeToggle: () => {},
    onStrafeHelperToggle: () => {},
    onCrosshairChange: () => {},
    onViewWeaponToggle: () => {},
    onVolumeChange: () => {},
    onMuteChange: () => {},
    onStartSoundsToggle: () => {},
    onFinishSoundsToggle: () => {},
    onDeathSoundsToggle: () => {},
    onObSoundsToggle: () => {},
    onBindsChange: () => {},
    onAutoSwitchChange: () => {},
    onSensitivityChange: () => {},
    onPostSettingChange: () => {},
  };
}

/** What storage holds right now, as a plain object. */
function stored(): Record<string, string> {
  const raw = window.localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

/** Open the screen on `tab`, with or without a live context. */
function open(live: SettingsLiveCallbacks | undefined, tab: string): void {
  document.body.innerHTML = '';
  // Spread rather than passing `live` outright: `exactOptionalPropertyTypes`
  // makes an explicit `live: undefined` a different thing from an absent
  // `live`, and "no course running" is the ABSENT one -- which is also the
  // shape `main.ts` uses when it opens this screen from the title.
  void showSettingsScreen(document.body, {
    mapName: 'ob_basics',
    paks: null,
    ...(live ? { live } : {}),
  });
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === tab,
  );
  if (!button) {
    throw new Error(`no ${tab} tab`);
  }
  button.click();
}

/**
 * Click the toggle in the row titled `title`.
 *
 * Located by its visible title rather than by index: a row added above it
 * should not silently retarget this at a different setting.
 */
function toggleRow(title: string): void {
  const row = [...document.querySelectorAll('.ob-set-row')].find(
    (r) => r.querySelector('.ob-set-title')?.textContent?.trim().toLowerCase() === title.toLowerCase(),
  );
  if (!row) {
    throw new Error(`no row titled ${title}`);
  }
  const button = row.querySelector('button');
  if (!button) {
    throw new Error(`row ${title} has no control`);
  }
  button.click();
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('a settings change opened over playback', () => {
  // The four HUD rows whose live callback does nothing over a recording.
  // `crosshair` is a dropdown rather than a toggle and `obhelp` a segmented
  // control, so the two covered here are the ones a click reaches directly;
  // all four share the one code path being tested.
  it('persists the strafe gauge even though the live callback does nothing', () => {
    open(noopLive(), 'HUD');
    toggleRow('Strafe gauge');
    expect(stored().strafegauge).toBe('0');
  });

  it('persists the strafe helper line', () => {
    open(noopLive(), 'HUD');
    toggleRow('Strafe helper line');
    expect(stored().strafehelper).toBe('1');
  });

  it('persists the ghost toggle', () => {
    open(noopLive(), 'HUD');
    toggleRow('Ghost');
    expect(stored().ghost).toBe('0');
  });

  it('persists every voice-line switch', () => {
    open(noopLive(), 'Audio');
    toggleRow('Start lines');
    toggleRow('Finish lines');
    toggleRow('Death sounds');
    toggleRow('Overbounce announcements');
    expect(stored()).toMatchObject({
      startsounds: '0',
      finishsounds: '0',
      deathsounds: '0',
      obsounds: '0',
    });
  });
});

describe('the mouse sensitivity slider', () => {
  /**
   * The range input in the card that mentions `title`.
   *
   * Located through the card rather than by index so that adding a slider
   * elsewhere on the tab cannot silently retarget this.
   */
  function slider(title: string): HTMLInputElement {
    const inputs = [...document.querySelectorAll('input[type=range]')] as HTMLInputElement[];
    const match = inputs.find((i) => i.closest('.ob-card')?.textContent?.includes(title));
    if (!match) {
      throw new Error(`no slider in a card mentioning ${title}`);
    }
    return match;
  }

  /** The typed box in the card that mentions `title`. */
  function box(title: string): HTMLInputElement {
    const inputs = [...document.querySelectorAll('input[type=text]')] as HTMLInputElement[];
    const match = inputs.find((i) => i.closest('.ob-card')?.textContent?.includes(title));
    if (!match) {
      throw new Error(`no text box in a card mentioning ${title}`);
    }
    return match;
  }

  /** Type into the box and leave it, which is what `change` is. */
  function type(value: string): void {
    const input = box('Sensitivity');
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** `input` is a drag tick; `change` is the release. */
  function drag(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function release(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('writes nothing while the slider is being dragged', () => {
    // The reason the write moved to commit: a write is a read-modify-write of
    // the whole settings blob plus a `history.replaceState`, and `input`
    // fires per mouse move.
    open(noopLive(), 'Controls');
    const input = slider('Sensitivity');
    drag(input, '7');
    drag(input, '8');
    drag(input, '9');
    expect(stored().sensitivity).toBeUndefined();
  });

  it('persists on release, even though the live callback does nothing', () => {
    // The playback door. Before the fix BOTH handlers went straight to
    // `context?.live?.onSensitivityChange` and this was lost entirely.
    open(noopLive(), 'Controls');
    release(slider('Sensitivity'), '9');
    expect(stored().sensitivity).toBe('9');
  });

  it('persists on release with no course running', () => {
    // The title-screen door, where `live` is undefined and `?.` used to
    // swallow the call whole.
    open(undefined, 'Controls');
    release(slider('Sensitivity'), '2.5');
    expect(stored().sensitivity).toBe('2.5');
  });

  it('clears the key when the slider returns to the default', () => {
    open(noopLive(), 'Controls');
    release(slider('Sensitivity'), '9');
    expect(stored().sensitivity).toBe('9');
    release(slider('Sensitivity'), '5');
    expect(stored().sensitivity).toBeUndefined();
  });

  it('spans 0.01 to 15, in steps the default is reachable by', () => {
    // A range input counts steps from its MINIMUM, so a 0.5 step over a 0.01
    // floor would never land on 5 -- the one value everybody needs. That is
    // the property asserted here, rather than the step's literal value.
    open(noopLive(), 'Controls');
    const input = slider('Sensitivity');
    expect(input.min).toBe('0.01');
    expect(input.max).toBe('15');

    // The default as the UI itself renders it, so this needs no second copy
    // of the constant to drift from the first.
    const steps = (Number(box('Sensitivity').value) - Number(input.min)) / Number(input.step);
    // NOT `Number.isInteger`: (5 - 0.01) / 0.01 is 499.00000000000006, which
    // is the very float dust `round2` exists to sweep up. Asking for an exact
    // integer here would fail against a perfectly correct control.
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  });

  it('commits a value typed into the box', () => {
    // The reason the box exists: a slider cannot be asked for 2.73.
    open(noopLive(), 'Controls');
    type('2.73');
    expect(stored().sensitivity).toBe('2.73');
  });

  it('reaches the bottom of the range, which the old 0.5 floor could not', () => {
    open(noopLive(), 'Controls');
    type('0.01');
    expect(stored().sensitivity).toBe('0.01');
  });

  it('clamps a typed value that is out of range', () => {
    open(noopLive(), 'Controls');
    type('99');
    expect(stored().sensitivity).toBe('15');
  });

  it('rejects text that is not a positive number, and writes nothing', () => {
    // Restored rather than clamped: a typo must not quietly become a setting.
    open(noopLive(), 'Controls');
    type('banana');
    expect(stored().sensitivity).toBeUndefined();
    expect(box('Sensitivity').value).toBe('5');
    type('-3');
    expect(stored().sensitivity).toBeUndefined();
  });

  it('clears the key when the default is typed', () => {
    open(noopLive(), 'Controls');
    type('9');
    expect(stored().sensitivity).toBe('9');
    type('5');
    expect(stored().sensitivity).toBeUndefined();
  });
});

describe('the same change with no course running', () => {
  // The door that always worked. Kept so a future "simplification" back to
  // an either/or cannot pass by fixing one door and breaking the other.
  it('persists the strafe gauge', () => {
    open(undefined, 'HUD');
    toggleRow('Strafe gauge');
    expect(stored().strafegauge).toBe('0');
  });

  it('persists the voice-line switches', () => {
    open(undefined, 'Audio');
    toggleRow('Death sounds');
    expect(stored().deathsounds).toBe('0');
  });
});

describe('the default is stored as absence, not as a value', () => {
  // Turning a setting off and on again must leave the key gone rather than
  // written as its default -- that is what makes `?? '1'` at every read site
  // the single source of the default.
  it('clears the key when the setting returns to its default', () => {
    open(noopLive(), 'Audio');
    toggleRow('Start lines');
    expect(stored().startsounds).toBe('0');
    toggleRow('Start lines');
    expect(stored().startsounds).toBeUndefined();
  });
});
