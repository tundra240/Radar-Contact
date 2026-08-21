/**
 * Every colour, font and line weight the scope draws with.
 *
 * One file, by design: tuning a radar display is done by eye, and hunting
 * hex codes across a dozen render modules is how palettes drift.
 *
 * Two complete palettes live here. `beige` is the shipped look -- a warm
 * chart-paper ground with dim, saturated accents, after the early-2000s
 * terminal displays that drew dark symbology on a light ground. `dark` is
 * the earlier near-black scheme, kept intact so switching is one line
 * rather than a rewrite. Accents are NOT shared between them: a colour that
 * glows on black turns to mud on beige, so each palette is tuned whole.
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

export const palettes: Record<'beige' | 'dark', Palette> = {
  beige: {
    bg: '#c9bfa3',

    ringFaint: '#bcb094',
    ring: '#a89b76',
    ringStrong: '#8a7d55',
    cardinal: '#94875f',
    ringLabel: '#5f5636',

    airspaceHigh: '#2d4f7c',
    airspaceControl: '#7a2f5f',
    airspaceLocal: '#6b5a20',
    airspaceLabel: '#4a4028',

    runway: '#17150f',
    runwayLabel: '#2f2a1c',
    centreline: '#6f6547',
    centrelineTick: '#574e33',
    fafTick: '#0a6b74',

    navaid: '#0d6a73',
    navaidLabel: '#0a4d54',
    navaidFreq: '#6a6040',
    hold: '#8a5000',

    neighbour: '#463f2b',
    neighbourLabel: '#3a3423',

    text: '#241f14',
    textDim: '#5f5636',
    accent: '#0a6b74',
    warn: '#a32000',

    chromeFace: '#bfb59a',
    chromeLight: '#e4dcc6',
    chromeShadow: '#736a51',
    chromeText: '#241f14',
    chromeDim: '#6b6248',
    chromeWell: '#ada291',
  },

  dark: {
    bg: '#0a0e14',

    ringFaint: '#121c24',
    ringStrong: '#1d3b47',
    ring: '#152b34',
    cardinal: '#24485a',
    ringLabel: '#3d5a68',

    airspaceHigh: '#2f5f8f',
    airspaceControl: '#a04080',
    airspaceLocal: '#8a7a30',
    airspaceLabel: '#7f8c99',

    runway: '#e6f7ff',
    runwayLabel: '#9fd4e6',
    centreline: '#1b4453',
    centrelineTick: '#2a6376',
    fafTick: '#00b8d4',

    navaid: '#00b8d4',
    navaidLabel: '#84dbec',
    navaidFreq: '#4a6b78',
    hold: '#c98a2a',

    neighbour: '#5a6b7c',
    neighbourLabel: '#7f8c99',

    text: '#c8d4e0',
    textDim: '#5a6b7c',
    accent: '#00e5ff',
    warn: '#ff5252',

    chromeFace: '#1b232c',
    chromeLight: '#33424f',
    chromeShadow: '#05080b',
    chromeText: '#c8d4e0',
    chromeDim: '#6b7d8c',
    chromeWell: '#101720',
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
