import type { Lang } from './lang';

/** The welcome sheet's words. In `controls`, keys are written in [brackets] (shown as keycaps). */
export interface WelcomeText {
  title: string;
  subtitle: string;
  scale: string;
  paragraphs: string[];
  controlsTitle: string;
  controls: [string, string][];
  start: string;
  close: string;
  /** The corner button that brings the sheet back. */
  reopen: string;
}

/** Narrow no-break space, before French ! ? : ; and a no-break space, between thousands. */
const nb = '\u202f';
const nbsp = '\u00a0';

export const WELCOME: Record<Lang, WelcomeText> = {
  en: {
    title: 'Terra Incognita',
    subtitle: 'An endless topographic map',
    scale: '1:10,000',
    paragraphs: [
      'Welcome! This is the map of a country that doesn’t exist. It’s drawn as you go: hills, contours, woods, streams, villages, roads, tracks and footpaths.',
      'Set off in any direction: the land never ends. But it doesn’t wait for you either. Scroll too far and it’s forgotten, and if you come back you’ll find somewhere new.',
      'Where the map isn’t drawn yet, it holds you back for a moment while the surveyors catch up.',
    ],
    controlsTitle: 'Getting around',
    controls: [
      ['Move', 'drag, or [←] [↑] [→] [↓] or [W] [A] [S] [D]'],
      ['Zoom', 'pinch, [Ctrl]/[⌘] + scroll, or [+] and [−]'],
      ['Legend', '[L], or the tab in the right margin'],
      ['This sheet', '[?], or the ? in the bottom-left corner'],
    ],
    start: 'Start exploring',
    close: 'Close',
    reopen: 'About this map',
  },
  nl: {
    title: 'Terra Incognita',
    subtitle: 'Een eindeloze topografische kaart',
    scale: '1:10.000',
    paragraphs: [
      'Welkom! Dit is de kaart van een land dat niet bestaat. Hij wordt getekend terwijl je rondkijkt: heuvels, hoogtelijnen, bossen, beken, dorpen, wegen, en paden.',
      'Kijk rond in elke richting: het land houdt nooit op. Maar als je verder scrolt wordt het ook weer vergeten; kom je terug, dan ligt er weer iets nieuws.',
      'Scrol niet te snel: even wachten tot de landmeters bij kunnen werken.',
    ],
    controlsTitle: 'Rondkijken',
    controls: [
      ['Bewegen', 'slepen, of [←] [↑] [→] [↓] of [W] [A] [S] [D]'],
      ['Zoomen', 'knijpen, [Ctrl]/[⌘] + scrollen, of [+] en [−]'],
      ['Legenda', '[L], of het tabje in de rechterrand'],
      ['Dit blad', '[?], of het ? in de hoek linksonder'],
    ],
    start: 'Op verkenning',
    close: 'Sluiten',
    reopen: 'Over deze kaart',
  },
  fr: {
    title: 'Terra Incognita',
    subtitle: 'Une carte topographique sans fin',
    scale: `1/10${nbsp}000`,
    paragraphs: [
      `Bienvenue${nb}! Voici la carte d’un pays qui n’existe pas. Elle se dessine au fil de vos pas${nb}: collines, courbes de niveau, bois, ruisseaux, villages, routes, chemins et sentiers.`,
      `Partez dans n’importe quelle direction${nb}: le pays ne s’arrête jamais. Mais il ne vous attend pas non plus. Allez trop loin et il est oublié${nb}; si vous revenez, vous trouverez un autre paysage.`,
      'Là où la carte n’est pas encore dessinée, elle vous retient un instant, le temps que les géomètres vous rattrapent.',
    ],
    controlsTitle: 'Se déplacer',
    controls: [
      ['Déplacer', 'glisser, ou [←] [↑] [→] [↓]'],
      ['Zoomer', 'pincer, [Ctrl]/[⌘] + molette, ou [+] et [−]'],
      ['Légende', '[L], ou l’onglet dans la marge de droite'],
      ['Cette feuille', '[?], ou le ? dans le coin en bas à gauche'],
    ],
    start: 'Explorer',
    close: 'Fermer',
    reopen: 'À propos de cette carte',
  },
  de: {
    title: 'Terra Incognita',
    subtitle: 'Eine endlose topografische Karte',
    scale: '1:10.000',
    paragraphs: [
      'Willkommen! Dies ist die Karte eines Landes, das es nicht gibt. Sie entsteht, während du dich umsiehst: Hügel, Höhenlinien, Wälder, Bäche, Dörfer, Straßen, Wirtschaftswege und Fußwege.',
      'Zieh in jede Richtung los: Das Land hört nie auf. Aber es wartet auch nicht auf dich. Scrollst du zu weit, wird es vergessen; kommst du zurück, findest du etwas Neues.',
      'Wo die Karte noch nicht gezeichnet ist, hält sie dich kurz auf, bis die Landvermesser nachkommen.',
    ],
    controlsTitle: 'Bedienung',
    controls: [
      ['Bewegen', 'ziehen, oder [←] [↑] [→] [↓] oder [W] [A] [S] [D]'],
      ['Zoomen', 'mit zwei Fingern, [Strg]/[⌘] + Mausrad, oder [+] und [−]'],
      ['Legende', '[L], oder der Reiter im rechten Rand'],
      ['Dieses Blatt', '[?], oder das ? in der Ecke unten links'],
    ],
    start: 'Los geht’s',
    close: 'Schließen',
    reopen: 'Über diese Karte',
  },
};
