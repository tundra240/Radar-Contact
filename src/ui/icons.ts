/**
 * Glyphs for the tool rail.
 *
 * A modern position labels its tools with symbols rather than words: the
 * rail is a column of small squares down the edge of the glass and there is
 * no room in one for "OVERLAYS". The period schemes keep the words, because
 * a Windows-2000 toolbar with wordless buttons would be the wrong decade.
 *
 * So every tool carries both, and the stylesheet shows whichever the idiom
 * calls for. That also means the accessible name is always the word: the
 * text is hidden from view under the flat idiom but never removed, so a
 * screen reader and a tooltip both still say what the button does.
 *
 * Drawn as inline SVG rather than an icon font or an image, for the same
 * reason everything else here is drawn rather than fetched: no request, no
 * licence, and it takes the current colour.
 */

/** 16x16 path data, stroked in `currentColor`. */
export const ICONS = {
  /** A cloud, for the weather layer. */
  wx: 'M4.5 12.5h7a2.75 2.75 0 0 0 .3-5.48 4 4 0 0 0-7.62-.9A2.8 2.8 0 0 0 4.5 12.5Z',
  /** A broadcast mast, for the ATIS. */
  atis: 'M8 6.5v7M5.2 4a5 5 0 0 0 0 6M10.8 4a5 5 0 0 1 0 6M3.2 2.2a8 8 0 0 0 0 9.6M12.8 2.2a8 8 0 0 1 0 9.6',
  /** A chevron and a rule: a command line. */
  console: 'M3.5 5l2.5 2.5L3.5 10M8 11.5h5',
  /** Two bars: pause. */
  pause: 'M6 3.5v9M10 3.5v9',
  /** A triangle: run. */
  play: 'M5.5 3.5l7 4.5-7 4.5Z',
  /** A dial, for the clock rate. */
  rate: 'M8 3.2a4.8 4.8 0 1 1-4.8 4.8M8 5.4V8l1.9 1.9M3.2 3.2v2.6h2.6',
  /** The sun: switch to the light scheme. */
  sun: 'M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2ZM8 1.6v1.6M8 12.8v1.6M2.5 8H1M15 8h-1.5M4.1 4.1 3 3M13 13l-1.1-1.1M11.9 4.1 13 3M3 13l1.1-1.1',
  /** The moon: switch to the dark scheme. */
  moon: 'M12.6 10.1A5.2 5.2 0 0 1 6.4 3.5a5.4 5.4 0 1 0 6.2 6.6Z',
  /** Stacked rules: the options menu. */
  menu: 'M3 4.5h10M3 8h10M3 11.5h10',
  /** An open book: the guide. */
  guide: 'M8 4.4C6.6 3.3 4.9 3 3 3.2v9.4c1.9-.2 3.6.1 5 1.2 1.4-1.1 3.1-1.4 5-1.2V3.2c-1.9-.2-3.6.1-5 1.2Zm0 0v9.4',
} as const

export type IconName = keyof typeof ICONS

const SVG_NS = 'http://www.w3.org/2000/svg'

/** One glyph, sized to the rail and inheriting the button's colour. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'tool-icon')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  // Decorative: the button's own text is the accessible name.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICONS[name])
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.3')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/**
 * Give a button both a glyph and a word.
 *
 * Replaces whatever was there, so it is safe to call again when the tool
 * changes what it means -- the rate button relabels itself every press, and
 * the scheme button swaps a sun for a moon.
 */
export function setToolLabel(button: HTMLElement, name: IconName, text: string): void {
  const word = document.createElement('span')
  word.className = 'tool-text'
  word.textContent = text
  button.replaceChildren(icon(name), word)
  // The word is hidden by CSS under the flat idiom rather than removed, so
  // this stays the accessible name in both.
  button.setAttribute('aria-label', text)
  if (!button.title) button.title = text
}
