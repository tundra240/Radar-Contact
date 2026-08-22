/**
 * Every colour, font and line weight the scope draws with.
 *
 * One file, by design: tuning a radar display is done by eye, and hunting
 * hex codes across a dozen render modules is how palettes drift.
 *
 * Four complete palettes live here, described where they are defined
 * below. Accents are NOT shared between them: a colour that glows on black
 * turns to mud on beige, so each palette is tuned whole against its own
 * ground and the contrast is asserted in theme.test.ts.
 */

/**
 * Whether panel edges are bevelled or flat. See Palette.chromeStyle.
 */
export type ChromeStyle = 'bevel' | 'flat'

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

  /**
   * The outline of the area of responsibility.
   *
   * Its own colour rather than one of the airspace classes, because on a
   * real position the sector you are working is the brightest line on the
   * map -- brighter than the runways, brighter than the coast -- and every
   * other boundary is drawn quietly behind it. It is the edge of the job.
   */
  readonly sector: string
  readonly runway: string
  readonly runwayLabel: string
  readonly centreline: string
  readonly centrelineTick: string
  readonly fafTick: string

  readonly navaid: string
  readonly navaidLabel: string
  readonly navaidFreq: string
  readonly hold: string

  /**
   * Precipitation, in three bands. Green, amber, red on a colour tube; on
   * the monochrome one they cannot be told apart by hue, so they are
   * separated by brightness the way a single-gun display had to do it.
   */
  readonly wxLight: string
  readonly wxModerate: string
  readonly wxHeavy: string

  /**
   * Traffic. The boldest ink in every palette, because the map is context
   * and the traffic is the job. The trail is the same mark one step
   * quieter, so a history never competes with the target it belongs to.
   */
  readonly target: string
  readonly trail: string

  readonly neighbour: string
  readonly neighbourLabel: string

  /**
   * The map underneath the airspace: the coastline, and the lateral limit
   * of the flight information region. The coast is furniture -- it is
   * there to orient you and must not compete with traffic -- while the FIR
   * boundary is a real airspace limit and is read as one.
   */
  readonly coast: string
  readonly fir: string

  readonly text: string
  readonly textDim: string
  readonly accent: string
  readonly warn: string

  /**
   * Which idiom the interface is drawn in -- everything about the era that
   * a colour cannot express.
   *
   * Not only the edges, though that is the most visible part of it:
   *
   * | | `bevel` | `flat` |
   * |---|---|---|
   * | Edges | light top-left, shadow bottom-right | one hairline |
   * | Readouts | a bevelled cell each, inset from the corner | a ruled table with a header row, flush to the glass |
   * | Position | a raised panel with a margin round it | a strip hard into the corner |
   * | Controls | wide labelled buttons, top right | a rail of small square buttons down the left |
   * | Captions | a saturated bar with light lettering | a ruled heading |
   *
   * `render/scope.ts` branches on this for the canvas furniture and the
   * stylesheet branches on it through a `data-chrome` attribute, so a scheme
   * cannot come out half a 1999 desktop and half a modern position.
   */
  readonly chromeStyle: ChromeStyle

  /**
   * Chrome: the panel faces that give the interface its look. Under
   * `bevel` the light and shadow are the two edges of the bevel; under
   * `flat` the light is the hairline border and the shadow is unused on
   * screen, so the ordering between them still has to hold either way.
   */
  readonly chromeFace: string
  /**
   * The colour of a hairline, for the schemes that draw one.
   *
   * Separate from `chromeLight` because a bevel highlight and a rule are
   * different things that only looked like the same thing while every flat
   * scheme happened to be dark. A highlight must be lighter than the face it
   * sits on or the bevel renders inside out; a rule on a pale face has to be
   * darker than it or there is no visible edge at all. One token cannot be
   * both, and making the light scheme obey the bevel rule would have given
   * it panels with no edges.
   */
  readonly chromeEdge: string
  readonly chromeLight: string
  readonly chromeShadow: string
  readonly chromeText: string
  readonly chromeDim: string
  readonly chromeWell: string
  /** Panel caption strip -- the most period detail in the whole interface. */
  readonly chromeTitleBar: string
  readonly chromeTitleText: string
}

/**
 * One modern scheme and three period ones.
 *
 * `tracon` is the shipped look, described where it is defined at the bottom
 * of this object: a present-day terminal radar position rather than a period
 * reference, and the only one whose panels are flat rather than bevelled.
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
 * Accents are never shared between them. Each palette is tuned whole
 * against its own ground, and theme.test.ts asserts the contrast so a
 * later tweak cannot quietly make the display unreadable.
 */
export const palettes = {
  beige: {
    bg: '#c3bda9',
    chromeStyle: 'bevel',

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

    sector: '#2a2418',
    runway: '#1a1a14',
    runwayLabel: '#2b2a1e',
    centreline: '#6b6552',
    centrelineTick: '#524d3c',
    fafTick: '#006e74',

    navaid: '#00686e',
    navaidLabel: '#00565c',
    navaidFreq: '#5f5a48',
    hold: '#8a4e00',

    // Dark and saturated, because a pale green on tan is a smudge.
    wxLight: '#2f6b2a',
    wxModerate: '#7a5c00',
    wxHeavy: '#8f1f14',

    // VGA dark green: the one bold ink the rest of this palette leaves
    // free, so traffic cannot be mistaken for a runway or a boundary.
    target: '#0e4a1c',
    trail: '#5f7a66',

    neighbour: '#46422f',
    neighbourLabel: '#3a3625',

    // Slate for the shoreline, against the tan ground; a darker slate
    // for the FIR limit, kept clear of the navy and purple used by the
    // controlled airspace.
    coast: '#7f8c96',
    fir: '#2f4858',

    text: '#1c1a14',
    textDim: '#4e4939',
    accent: '#006e74',
    warn: '#a00000',

    // The canonical button face of the era, with a white highlight and a
    // mid-grey shadow. Nothing dates an interface faster than getting
    // these three wrong.
    chromeFace: '#d4d0c8',
    chromeEdge: '#ffffff',
    chromeLight: '#ffffff',
    chromeShadow: '#808080',
    chromeText: '#1c1a14',
    chromeDim: '#565246',
    chromeWell: '#aeaaa2',
    // Navy with white lettering: nothing else says this decade so quickly.
    chromeTitleBar: '#000080',
    chromeTitleText: '#ffffff',
  },

  dark: {
    bg: '#080e13',
    chromeStyle: 'bevel',

    ringFaint: '#0d1a21',
    ring: '#13303c',
    ringStrong: '#1d4756',
    cardinal: '#245363',
    ringLabel: '#3f6d80',

    airspaceHigh: '#5a8ad8',
    airspaceControl: '#d060b0',
    airspaceLocal: '#b0a030',
    airspaceLabel: '#8092a0',

    sector: '#e6f0f4',
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

    wxLight: '#29a05a',
    wxModerate: '#d9c020',
    wxHeavy: '#e0452f',

    target: '#40ff80',
    trail: '#217a42',

    neighbour: '#5a6b7a',
    neighbourLabel: '#8092a0',

    // Dim slate for the shoreline; a lighter slate for the FIR limit,
    // kept clear of the blue and magenta used by controlled airspace.
    coast: '#26414c',
    fir: '#6a7f95',

    text: '#c4dae6',
    textDim: '#5c7382',
    accent: '#00e5ff',
    warn: '#ff5252',

    chromeFace: '#18222b',
    chromeEdge: '#3a4a52',
    chromeLight: '#3d5162',
    chromeShadow: '#040709',
    chromeText: '#c4dae6',
    chromeDim: '#6c8494',
    chromeWell: '#0d151c',
    chromeTitleBar: '#123c52',
    chromeTitleText: '#cfe6f2',
  },

  /**
   * A 2010s terminal radar position, and the only scheme here that is not
   * period furniture: flat panels, hairline borders, no bevel anywhere.
   *
   * The ground is not black. Every modern radar room photograph shows a
   * dark, slightly blue-green slate -- black would be right for a CRT and
   * is wrong for an LCD in a dimmed room, where it goes grey anyway and
   * takes the contrast with it. The symbology is the mint green those
   * displays actually use, and it is used for almost everything, because
   * the modern convention is one ink for data and a very quiet map
   * underneath rather than the colour-coded-by-class picture the older
   * schemes draw. Airspace keeps a little hue so the classes are still
   * separable, but pulled well down.
   *
   * The traffic is the brightest thing on the display by a wide margin --
   * 12:1 against the ground, where the map furniture sits under 2:1. That
   * gap is the whole look.
   */
  traconDark: {
    bg: '#0b171c',
    chromeStyle: 'flat',

    ringFaint: '#101f25',
    ring: '#17323a',
    ringStrong: '#21474f',
    cardinal: '#1c3d45',
    ringLabel: '#5f9a9a',

    airspaceHigh: '#4f86b8',
    airspaceControl: '#a86fc0',
    airspaceLocal: '#8f9a58',
    airspaceLabel: '#7f9aa0',

    sector: '#eaf7f3',
    runway: '#dff3f0',
    runwayLabel: '#8fd8c4',
    centreline: '#1b3a42',
    centrelineTick: '#3f8f80',
    fafTick: '#7fe8d0',

    navaid: '#3fc9a4',
    navaidLabel: '#63d9b6',
    navaidFreq: '#4a8f80',
    // Warm against an otherwise entirely cool picture, so the fixes traffic
    // is stacked over are the one thing that is not mint.
    hold: '#f0b45c',

    wxLight: '#2f8f5f',
    wxModerate: '#c8a03f',
    wxHeavy: '#e05555',

    target: '#5cf0b8',
    trail: '#2a7f68',

    neighbour: '#5f8f92',
    neighbourLabel: '#7fa8aa',

    coast: '#20414a',
    fir: '#6f93a8',

    text: '#cfe6e2',
    textDim: '#7fa39e',
    accent: '#4fe3ab',
    warn: '#ff5b5b',

    // Flat: the face is a shade above the ground and the light is a
    // hairline border, not a highlight. The shadow is kept darker than the
    // face so the ordering holds, but nothing on screen draws with it.
    chromeFace: '#132229',
    chromeEdge: '#2f5560',
    chromeLight: '#2f5560',
    chromeShadow: '#04090b',
    chromeText: '#cfe6e2',
    chromeDim: '#8fb0ac',
    chromeWell: '#081216',
    chromeTitleBar: '#1b4a4a',
    chromeTitleText: '#a8f0d4',
  },
  /**
   * The same position under room lighting.
   *
   * Not an inversion of the dark one. A dark scope glows and a light one is
   * ink on paper, so the symbology goes dark and the ground goes pale -- but
   * the hues stay exactly where they were, mint for the navaids and the
   * traffic and warm for the holds, so the two read as one instrument in two
   * lighting conditions rather than as two products.
   *
   * The grid is the hard part of a light scheme. On a dark ground a ring can
   * be dim and still legible; on a pale one it has nowhere to go but towards
   * the traffic, so these sit deliberately close to the ground -- just above
   * the floor the contrast gate sets, and nowhere near its ceiling.
   */
  traconLight: {
    bg: '#dde5e8',
    chromeStyle: 'flat',

    ringFaint: '#d4dee1',
    ring: '#b6c9cf',
    ringStrong: '#a6bcc4',
    cardinal: '#a9bfc7',
    ringLabel: '#356265',

    airspaceHigh: '#2a5480',
    airspaceControl: '#6d3583',
    airspaceLocal: '#55601c',
    airspaceLabel: '#3a565d',

    sector: '#08181d',
    runway: '#0c2429',
    runwayLabel: '#125946',
    centreline: '#b3c7ce',
    centrelineTick: '#2a7161',
    fafTick: '#0d6350',

    navaid: '#0f7259',
    navaidLabel: '#0d6350',
    navaidFreq: '#39655d',
    // Warm against an otherwise entirely cool picture, the same role the
    // amber holds play on the dark scheme.
    hold: '#8a5410',

    wxLight: '#2a7350',
    wxModerate: '#7d6010',
    wxHeavy: '#b0231f',

    target: '#052c34',
    trail: '#7ba0a6',

    neighbour: '#456a6d',
    neighbourLabel: '#3a5c5f',

    coast: '#afc3ca',
    fir: '#456885',

    text: '#0b1f24',
    textDim: '#3d5d64',
    accent: '#0a6650',
    warn: '#ab1f28',

    chromeFace: '#eaf0f2',
    chromeEdge: '#9db2ba',
    // Bevel values it never draws, kept ordered so the scheme could be
    // switched to bevelled without rendering inside out. The edge it
    // actually uses is chromeEdge above.
    chromeLight: '#ffffff',
    chromeShadow: '#9aacb3',
    chromeText: '#0b1f24',
    chromeDim: '#4a6a71',
    chromeWell: '#dbe3e6',
    chromeTitleBar: '#17454e',
    chromeTitleText: '#d8f0e6',
  },
} satisfies Record<string, Palette>

export type PaletteName = keyof typeof palettes

/**
 * Cycle order for the display control.  first because it is the
 * shipped look -- the modern position the game is actually modelled on --
 * and the three period schemes after it, amber last because it is the most
 * opinionated.
 */
export const PALETTE_ORDER: readonly PaletteName[] = [
  'traconDark',
  'traconLight',
  'beige',
  'dark',
]

/**
 * What each scheme is called on screen.
 *
 * Separate from the key because the two answer different questions. The key
 * says what the colours are -- `beige` is beige -- and the label says what
 * the choice means to somebody picking one, which is whether they want the
 * modern position or the period one, light or dark. Renaming the keys to
 * match would have touched a hundred call sites to change four words.
 */
export const PALETTE_LABEL: Record<PaletteName, string> = {
  traconDark: 'TRACON Dark',
  traconLight: 'TRACON Light',
  beige: 'Classic Light',
  dark: 'Classic Dark',
}

export function isPaletteName(value: unknown): value is PaletteName {
  return typeof value === 'string' && (PALETTE_ORDER as readonly string[]).includes(value)
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/** The modern position is the shipped default; the button cycles away. */
const DEFAULT_PALETTE: PaletteName = 'traconDark'

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

/** The next scheme in the cycle, without switching to it. */
export function nextPaletteName(): PaletteName {
  const i = PALETTE_ORDER.indexOf(activeName)
  return PALETTE_ORDER[(i + 1) % PALETTE_ORDER.length] ?? 'traconDark'
}

/** Advances to the next scheme and returns it. */
export function cyclePalette(): PaletteName {
  setPalette(nextPaletteName())
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
