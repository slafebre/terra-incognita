/** Languages the map's sheets (legend, welcome) are written in. */
export const LANGS = ['en', 'nl', 'fr', 'de'] as const;
export type Lang = (typeof LANGS)[number];

/** `?lang=xx` if it's one of ours, else the first of the browser's languages that is, else English. */
export function pickLang(param: string | null, prefs: readonly string[]): Lang {
  for (const tag of [param ?? '', ...prefs]) {
    const l = tag.toLowerCase().split(/[-_]/)[0];
    if ((LANGS as readonly string[]).includes(l)) return l as Lang;
  }
  return 'en';
}
