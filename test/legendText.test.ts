import { describe, expect, it } from 'vitest';
import { pickLang } from '../src/view/legendText';

describe('legend language', () => {
  it('follows the first supported browser language', () => {
    expect(pickLang(null, ['nl-BE', 'fr'])).toBe('nl');
    expect(pickLang(null, ['es-ES', 'de-AT', 'en'])).toBe('de');
    expect(pickLang(null, ['FR_ch'])).toBe('fr');
  });
  it('falls back to English', () => {
    expect(pickLang(null, ['es', 'it'])).toBe('en');
    expect(pickLang(null, [])).toBe('en');
  });
  it('lets ?lang override, unless unsupported', () => {
    expect(pickLang('de', ['nl'])).toBe('de');
    expect(pickLang('xx', ['nl'])).toBe('nl');
  });
});
