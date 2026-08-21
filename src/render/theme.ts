/**
 * Every colour, font and line weight the scope draws with.
 *
 * One file, by design: tuning a radar display is done by eye, and hunting
 * hex codes across a dozen render modules is how palettes drift.
 *
 * Two complete palettes live here, described where they are defined
 * below. Accents are NOT shared between them: a colour that glows on black
 * turns to mud on beige, so each palette is tuned whole against its own
 * ground and the contrast is asserted in theme.test.ts.
 */

export interface Palette {
  readonly bg: string

  readonly ringFaint: string
  readonly ring: string
  readonly ringStrong: string
  readonly cardinal: string
  readonly ringLabel: string

  /** Airspace boundaries, keyed loosely by class. */
  readonly airspaceHigh: string
  readonly airspaceControl: string
  readonly airspaceLocal: string
  readonly airspaceLabel: string

  readonly runway: string
  readonly runwayLabel: string
  readonly centreline: string
  readonly centrelineTick: string
  readonly fafTick: string

  readonly navaid: string
  readonly navaidLabel: string
  readonly navaidFreq: string
  readonly hold: string

  readonly neighbour: string
  readonly neighbourLabel: string

  readonly text: string
  readonly textDim: string
  readonly accent: string
  readonly warn: string

  /**
   * Chrome: the raised and sunken panel faces that give the interface its
   * period look. Bevels are drawn as a light edge on the top and left and a
   * shadow edge on the bottom and right, so both need to exist per palette
   * rather than being derived with a filter.
   */
  readonly chromeFace: string
  readonly chromeLight: string
  readonly chromeShadow: string
  readonly chromeText: string
  readonly chromeDim: string
  readonly chromeWell: string
}

/**
 * Two period palettes.
 *
 * `beige` takes its cue from the desktop software of the era rather than
 * from a modern light theme: a warm tan tube, an interface face in the
 * canonical #d4d0c8 with white and grey bevels, and symbology drawn from
 * the VGA system colours -- navy, teal, olive, maroon, purple. Those
 * colours are dark and saturated, which is exactly what stays readable on
 * a light ground where a modern neon would turn to mud.
 *
 * `dark` is the same instrument as a colour CRT: near-black with bright
 * cyan symbology and phosphor amber for anything the controller is holding
 * in mind.
 *
 * Accents are never shared between the two. Each palette is tuned whole
 * against its own ground, and theme.test.ts asserts the contrast so a
 * later tweak cannot quietly make the display unreadable.
 */
export const palettes: Record<'beige' | 'dark', Palette> = {
  beige: {
    bg: '#c3bda9',

    ringFaint: '#b4ae9a',
    ring: '#9a9482',
    ringStrong: '#7c7663',
    cardinal: '#8a8472',
    ringLabel: '#55503f',

    // VGA system navy, purple and olive: class A, the control zones, and
    // class G, in that order of authority.
    airspaceHigh: '#000080',
    airspaceControl: '#7a0060',
    airspaceLocal: '#6b6a00',
    airspaceLabel: '#46422f',

    runway: '#1a1a14',
    runwayLabel: '#2b2a1e',
    centreline: '#6b6552',
    centrelineTick: '#524d3c',
    fafTick: '#006e74',

    navaid: '#00686e',
    navaidLabel: '#00565c',
    navaidFreq: '#5f5a48',
    hold: '#8a4e00',

    neighbour: '#46422f',
    neighbourLabel: '#3a3625',

    text: '#1c1a14',
    textDim: '#4e4939',
    accent: '#006e74',
    warn: '#a00000',

    // The canonical button face of the era, with a white highlight and a
    // mid-grey shadow. Nothing dates an interface faster than getting
    // these three wrong.
    chromeFace: '#d4d0c8',
    chromeLight: '#ffffff',
    chromeShadow: '#808080',
    chromeText: '#1c1a14',
    chromeDim: '#565246',
    chromeWell: '#aeaaa2',
  },

  dark: {
    bg: '#080e13',

    ringFaint: '#0d1a21',
    ring: '#13303c',
    ringStrong: '#1d4756',
    cardinal: '#245363',
    ringLabel: '#3f6d80',

    airspaceHigh: '#5a8ad8',
    airspaceControl: '#d060b0',
    airspaceLocal: '#b0a030',
    airspaceLabel: '#8092a0',

    runway: '#e8f8ff',
    runwayLabel: '#9fd4e6',
    centreline: '#1b4152',
    centrelineTick: '#2d7089',
    fafTick: '#00e0c8',

    navaid: '#00c8d8',
    navaidLabel: '#7fdcea',
    navaidFreq: '#4a707e',
    // Phosphor amber, for the fixes traffic is actually holding at.
    hold: '#ffb000',

    neighbour: '#5a6b7a',
    neighbourLabel: '#8092a0',

    text: '#c4dae6',
    textDim: '#5c7382',
    accent: '#00e5ff',
    warn: '#ff5252',

    chromeFace: '#18222b',
    chromeLight: '#3d5162',
    chromeShadow: '#040709',
    chromeText: '#c4dae6',
    chromeDim: '#6c8494',
    chromeWell: '#0d151c',
  },
}

export type PaletteName = keyof typeof palettes

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/** Beige is the shipped default; the button switches away from it. */
const DEFAULT_PALETTE: PaletteName = 'beige'

/**
 * The active palette, exported as a live object rather than a value. Every
 * render module holds this same reference, so switching schemes mutates it
 * in place and the next frame simply picks up the new colours -- no
 * re-wiring, no palette argument threaded through every draw call.
 */
const active: Writable<Palette> = { ...palettes[DEFAULT_PALETTE] }
export const theme: Palette = active

let activeName: PaletteName = DEFAULT_PALETTE

export function paletteName(): PaletteName {
  return activeName
}

export function setPalette(name: PaletteName): void {
  Object.assign(active, palettes[name])
  activeName = name
}

export function togglePalette(): PaletteName {
  setPalette(activeName === 'beige' ? 'dark' : 'beige')
  return activeName
}

export const FONT_MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

export const fonts = {
  label: (px: number): string => `${px}px ${FONT_MONO}`,
  bold: (px: number): string => `bold ${px}px ${FONT_MONO}`,
} as const

/**
 * Airspace boundary colour by class: the high-level control area, the
 * control zones around each field, and the local class G traffic zones.
 */
export function airspaceColour(airspaceClass: string): string {
  if (airspaceClass === 'A' || airspaceClass === 'B' || airspaceClass === 'C') {
    return theme.airspaceHigh
  }
  if (airspaceClass === 'D' || airspaceClass === 'E') return theme.airspaceControl
  return theme.airspaceLocal
}

/** Vertical limit as it would appear on a chart: SFC, feet, or a level. */
export function formatLevel(ft: number): string {
  if (ft <= 0) return 'SFC'
  if (ft >= 10000) return `FL${Math.round(ft / 100)}`
  return String(ft)
}
