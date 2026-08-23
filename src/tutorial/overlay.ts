/**
 * The lesson's two pieces of interface: the mask and the card.
 *
 * The mask darkens the display and cuts a bright hole around whatever the
 * step is talking about. It is drawn as one SVG rather than four divs
 * arranged around a gap, because the thing being pointed at is often an
 * aircraft -- which moves, every tick -- and a shape that can be replaced
 * wholesale each frame is a great deal easier to keep honest than four
 * rectangles that have to stay adjacent.
 *
 * Nothing here decides anything. It is told what to show and it shows it,
 * which is what keeps every rule about what counts as progress in
 * engine.ts where it can be tested.
 */

const NS = 'http://www.w3.org/2000/svg'

/** A hole in the mask, in viewport pixels. */
export interface Hole {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Corner radius. A target gets a round hole, a button a soft-cornered one. */
  readonly r?: number
}

export interface CardView {
  readonly title: string
  /** "Step 4 of 16". */
  readonly counter: string
  readonly text: string
  /** The button's words, or null for a step that advances on an action. */
  readonly button: string | null
}

export interface OverlayOptions {
  readonly mount: HTMLElement
  readonly onContinue: () => void
  readonly onExit: () => void
}

/** How far the bright ring sits outside the thing it is drawn around. */
const PADDING_PX = 6

export class TutorialOverlay {
  private readonly root: HTMLDivElement
  private readonly svg: SVGSVGElement
  private readonly darkened: SVGRectElement
  private readonly maskHoles: SVGGElement
  private readonly rings: SVGGElement
  private readonly card: HTMLDivElement
  private readonly titleEl: HTMLDivElement
  private readonly counterEl: HTMLDivElement
  private readonly textEl: HTMLParagraphElement
  private readonly buttonEl: HTMLButtonElement
  private readonly toastEl: HTMLDivElement
  private toastTimer: number | null = null
  private readonly maskId: string

  constructor(opts: OverlayOptions) {
    this.maskId = `tutorial-cutout-${Math.floor(performance.now())}`

    this.root = document.createElement('div')
    this.root.className = 'tutorial'
    this.root.hidden = true

    /* ---- the mask ---- */
    this.svg = document.createElementNS(NS, 'svg')
    this.svg.setAttribute('class', 'tutorial-mask')
    // The mask never takes a click. Darkening the display is a way of
    // saying "look here", not a way of stopping the controller doing
    // anything else -- and a lesson that would not let you pan the scope
    // while reading about it would be a worse lesson.
    this.svg.setAttribute('aria-hidden', 'true')

    const defs = document.createElementNS(NS, 'defs')
    const mask = document.createElementNS(NS, 'mask')
    mask.setAttribute('id', this.maskId)

    // White shows the darkening, black hides it: the holes are painted
    // black into an otherwise white mask.
    const all = document.createElementNS(NS, 'rect')
    all.setAttribute('x', '0')
    all.setAttribute('y', '0')
    all.setAttribute('width', '100%')
    all.setAttribute('height', '100%')
    all.setAttribute('fill', 'white')

    this.maskHoles = document.createElementNS(NS, 'g')
    mask.append(all, this.maskHoles)
    defs.appendChild(mask)

    this.darkened = document.createElementNS(NS, 'rect')
    this.darkened.setAttribute('x', '0')
    this.darkened.setAttribute('y', '0')
    this.darkened.setAttribute('width', '100%')
    this.darkened.setAttribute('height', '100%')
    this.darkened.setAttribute('class', 'tutorial-shade')
    this.darkened.setAttribute('mask', `url(#${this.maskId})`)

    this.rings = document.createElementNS(NS, 'g')
    this.svg.append(defs, this.darkened, this.rings)

    /* ---- the card ---- */
    this.card = document.createElement('div')
    this.card.className = 'tutorial-card'
    this.card.setAttribute('role', 'dialog')
    this.card.setAttribute('aria-live', 'polite')

    const head = document.createElement('div')
    head.className = 'tutorial-head'

    this.counterEl = document.createElement('div')
    this.counterEl.className = 'tutorial-counter'

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tutorial-close'
    close.textContent = 'END LESSON'
    close.addEventListener('click', () => opts.onExit())

    head.append(this.counterEl, close)

    this.titleEl = document.createElement('div')
    this.titleEl.className = 'tutorial-title'

    this.textEl = document.createElement('p')
    this.textEl.className = 'tutorial-text'

    this.buttonEl = document.createElement('button')
    this.buttonEl.type = 'button'
    this.buttonEl.className = 'tutorial-continue'
    this.buttonEl.addEventListener('click', () => opts.onContinue())

    this.toastEl = document.createElement('div')
    this.toastEl.className = 'tutorial-toast'
    this.toastEl.hidden = true

    this.card.append(head, this.titleEl, this.textEl, this.buttonEl, this.toastEl)
    this.root.append(this.svg, this.card)
    opts.mount.appendChild(this.root)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Visible for tests and for anything that needs to measure the card. */
  get element(): HTMLElement {
    return this.root
  }

  show(view: CardView): void {
    this.root.hidden = false
    this.paint(view)
  }

  hide(): void {
    this.root.hidden = true
    this.place([])
    this.clearToast()
  }

  paint(view: CardView): void {
    this.titleEl.textContent = view.title
    this.counterEl.textContent = view.counter
    this.textEl.textContent = view.text
    // A step advancing on something the player does has no button rather
    // than a disabled one: a control that cannot be pressed still invites
    // pressing, and the instruction already says what to do.
    this.buttonEl.hidden = view.button === null
    this.buttonEl.textContent = view.button ?? ''
  }

  /**
   * Where the holes are, in viewport pixels.
   *
   * Replaced wholesale on every call. An aircraft moves under the mask
   * twenty times a second and the alternative -- diffing rectangles against
   * the ones already there -- would be more code to get subtly wrong for no
   * gain at this size.
   */
  place(holes: readonly Hole[]): void {
    this.maskHoles.replaceChildren()
    this.rings.replaceChildren()

    // No holes at all means no shade: a step pointing at nothing in
    // particular should not black out the display.
    this.darkened.setAttribute('opacity', holes.length === 0 ? '0' : '1')

    for (const hole of holes) {
      const x = hole.x - PADDING_PX
      const y = hole.y - PADDING_PX
      const w = hole.w + PADDING_PX * 2
      const h = hole.h + PADDING_PX * 2
      const r = String(hole.r ?? 4)

      const cut = document.createElementNS(NS, 'rect')
      cut.setAttribute('x', String(x))
      cut.setAttribute('y', String(y))
      cut.setAttribute('width', String(Math.max(0, w)))
      cut.setAttribute('height', String(Math.max(0, h)))
      cut.setAttribute('rx', r)
      cut.setAttribute('fill', 'black')
      this.maskHoles.appendChild(cut)

      const ring = document.createElementNS(NS, 'rect')
      ring.setAttribute('x', String(x))
      ring.setAttribute('y', String(y))
      ring.setAttribute('width', String(Math.max(0, w)))
      ring.setAttribute('height', String(Math.max(0, h)))
      ring.setAttribute('rx', r)
      ring.setAttribute('class', 'tutorial-ring')
      this.rings.appendChild(ring)
    }
  }

  /**
   * A line that says something happened and then goes away.
   *
   * For the step reset, which needs to be noticed and must not need
   * dismissing: a player who has just lost separation has enough to do.
   */
  toast(text: string, forMs = 4000): void {
    this.clearToast()
    this.toastEl.textContent = text
    this.toastEl.hidden = false
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true
      this.toastTimer = null
    }, forMs)
  }

  private clearToast(): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer)
    this.toastTimer = null
    this.toastEl.hidden = true
  }
}

/** An element's hole, or null when it is not on the screen. */
export function holeOfElement(selector: string): Hole | null {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) return null
  if (el.hidden || el.offsetParent === null) {
    // Not laid out. jsdom reports no offsetParent for everything, so the
    // rectangle is still trusted when it has a size.
    const box = el.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) return null
  }
  const box = el.getBoundingClientRect()
  return { x: box.x, y: box.y, w: box.width, h: box.height, r: 4 }
}

/** A hole of a given size centred on a point, for things drawn on canvas. */
export function holeAround(
  at: { readonly x: number; readonly y: number },
  sizePx: number,
): Hole {
  return {
    x: at.x - sizePx / 2,
    y: at.y - sizePx / 2,
    w: sizePx,
    h: sizePx,
    r: sizePx / 2,
  }
}
