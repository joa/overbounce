/**
 * Q3's `^N` in-string colour codes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { Q3_COLORS, splitQ3Colors } from '../../src/render/q3-colors.js';

describe('splitQ3Colors', () => {
  it('a string with no colour codes is one white segment', () => {
    expect(splitQ3Colors('hello')).toEqual([{ text: 'hello', color: '#ffffff' }]);
  });

  it('switches colour at each code, verified against g_color_table order', () => {
    expect(splitQ3Colors('^1red^2green^7white')).toEqual([
      { text: 'red', color: '#ff0000' },
      { text: 'green', color: '#00ff00' },
      { text: 'white', color: '#ffffff' },
    ]);
  });

  it('a leading code needs no text before it -- no empty segment', () => {
    expect(splitQ3Colors('^1red')).toEqual([{ text: 'red', color: '#ff0000' }]);
  });

  it('a trailing code with nothing after it contributes nothing', () => {
    expect(splitQ3Colors('white^1')).toEqual([{ text: 'white', color: '#ffffff' }]);
  });

  it('every digit 0-9 resolves to Q3_COLORS at that index', () => {
    for (let i = 0; i <= 9; i++) {
      expect(splitQ3Colors(`^${i}x`)).toEqual([{ text: 'x', color: Q3_COLORS[i] }]);
    }
  });

  it('the OSP/DeFRaG extension: 8 is orange, 9 is medium grey', () => {
    expect(splitQ3Colors('^8x')).toEqual([{ text: 'x', color: '#ff8000' }]);
    expect(splitQ3Colors('^9x')).toEqual([{ text: 'x', color: '#808080' }]);
  });

  it('^^ followed by a colour digit prints one literal caret, then switches', () => {
    // Q_IsColorString (q_shared.h) requires the character after ^ to exist
    // and not be another ^. The first ^ fails that test and is emitted
    // as-is; the second ^ is then re-examined against ITS next character,
    // which here forms a real code with the 7.
    expect(splitQ3Colors('a^^7b')).toEqual([{ text: 'a^', color: '#ffffff' }, { text: 'b', color: '#ffffff' }]);
  });

  it('^^ followed by anything else prints two literal carets', () => {
    // The second ^ ALSO fails Q_IsColorString here (its own next char, "x",
    // is not a digit) -- "doubling escapes a caret" only holds when a real
    // colour code follows the pair.
    expect(splitQ3Colors('a^^xb')).toEqual([{ text: 'a^^xb', color: '#ffffff' }]);
  });

  it('a caret at the very end of the string, with nothing after it, is literal', () => {
    expect(splitQ3Colors('a^')).toEqual([{ text: 'a^', color: '#ffffff' }]);
  });

  it('a caret followed by a non-digit is literal -- this parser only recognises 0-9', () => {
    // Vanilla Q3 actually computes SOME colour for ANY following character
    // via `((c) - '0') & 7` -- deliberately not replicated here; see the
    // file header for why that calling convention is unverified in this
    // checkout. `^d` stays plain text, dollar sign and all.
    expect(splitQ3Colors('^d')).toEqual([{ text: '^d', color: '#ffffff' }]);
  });

  it('an empty string produces no segments', () => {
    expect(splitQ3Colors('')).toEqual([]);
  });

  it('consecutive codes with no text between them do not emit empty segments', () => {
    expect(splitQ3Colors('^1^2^3x')).toEqual([{ text: 'x', color: '#ffff00' }]);
  });
});
