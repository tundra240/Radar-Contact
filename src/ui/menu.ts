import { SPEEDS, formatSpeed, type Speed } from '../core/loop'
import { setToolLabel } from './icons'
import {
  OVERLAY_ITEMS,
  OVERLAY_PRESETS,
  densityOf,
  nextDensity,
  type OverlayKey,
  type Overlays,
} from '../render/overlays'
import { PALETTE_LABEL, PALETTE_ORDER, type PaletteName } from '../render/theme'

/**
 * The options menu.
 *
 * Everything that is a setting rather than an instruction lives behind one
 * button: the simulation rate, interface sound, the display scheme and the
 * overlay layers. Previously each of those was its own control floating in
 * the corner of the scope, which cost three rows of chrome over the radar
 * picture and gave no clue that they belonged together.
 *
 * Two things it deliberately does not do:
 *
 * - **Hold state.** The loop owns the rate, `theme.ts` owns the palette and
 *   `main.ts` owns the overlay record. The menu is a view: it reports
 *   clicks through its callbacks and is told what to display by `paint()`.
 *   The only state it keeps is whether it is open.
 * - **Enumerate anything twice.** The rates come from `SPEEDS`, the schemes
 *   from `PALETTE_ORDER` and the layers from `OVERLAY_ITEMS`, so a rate or a
 *   layer cannot exist in the simulation or the render path without also
 *   being reachable here.
 *
 * The rate and pause state are still drawn on the scope's status bar, so
 * putting the buttons behind a menu hides the controls without hiding the
 * information -- you can always see whether the clock is running and how
 * fast, without opening anything.
 */

/** What the menu should currently be showing. `main.ts` owns all of it. */
export interface MenuState {
  readonly overlays: Overlays
  readonly palette: PaletteName
  readonly speed: Speed
  readonly paused: boolean
  readonly muted: boolean
}

export interface MenuOptions {
  readonly mount: HTMLElement
  readonly onOverlays: (next: Overlays) => void
  readonly onPalette: (next: PaletteName) => void
  readonly onSpeed: (next: Speed) => void
  readonly onTogglePause: () => void
  readonly onToggleSound: () => void
  /**
   * Called when the panel opens or closes.
   *
   * The rail's panels all occupy the same strip of glass beside it, so two
   * open at once is two stacked on each other. Whoever owns them uses this
   * to put the others away.
   */
  readonly onToggle?: (open: boolean) => void
  readonly onSave: () => void
  readonly onLoad: () => void
}

/**
 * A word on what each scheme is, for the control's tooltip.
 *
 * Typed as a total record over `PaletteName` rather than a lookup that can
 * miss, so adding a fourth palette is a compile error here rather than a
 * silently unlabelled button.
 */
const SCHEME_NOTE: Record<PaletteName, string> = {
  traconDark: 'A present-day terminal radar position, lights down',
  traconLight: 'The same position under room lighting',
  beige: 'A Windows-2000-era desktop with a tan tube',
  dark: 'A colour CRT',
}

export class Menu {
  private readonly opts: MenuOptions
  private readonly root: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly panel: HTMLDivElement

  private readonly pauseButton: HTMLButtonElement
  private readonly speedButtons = new Map<Speed, HTMLButtonElement>()
  private readonly soundBox: HTMLInputElement
  private readonly schemeButtons = new Map<PaletteName, HTMLButtonElement>()
  private readonly densityButton: HTMLButtonElement
  private readonly overlayBoxes = new Map<OverlayKey, HTMLInputElement>()

  /**
   * Tracked explicitly rather than read back off the element: the DOM
   * `hidden` property is typed `string | boolean` because it also accepts
   * "until-found", which is not a state this panel wants to reason about.
   */
  private isOpen = false

  /** Latest overlays as painted, so a checkbox can build the next record. */
  private overlays: Overlays = OVERLAY_PRESETS.standard

  private readonly onDocumentPointerDown: (e: PointerEvent) => void
  private readonly onDocumentKeyDown: (e: KeyboardEvent) => void

  constructor(opts: MenuOptions) {
    this.opts = opts

    this.root = document.createElement('div')
    this.root.className = 'menu'

    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'mode-toggle menu-button'
    setToolLabel(this.button, 'menu', 'Options')
    this.button.title = 'Simulation, display and overlay options'
    this.button.setAttribute('aria-haspopup', 'true')
    this.button.addEventListener('click', () => this.setOpen(!this.isOpen))
    this.root.appendChild(this.button)

    this.panel = document.createElement('div')
    this.panel.className = 'menu-panel'
    this.panel.hidden = true
    this.panel.setAttribute('role', 'group')
    this.panel.setAttribute('aria-label', 'Options')

    const caption = document.createElement('div')
    caption.className = 'menu-title'
    caption.textContent = 'Options'
    this.panel.appendChild(caption)

    /* ---- simulation ---------------------------------------------------
       Rate first, because it is the only thing here that changes while you
       are actually working traffic. */

    const sim = this.section('Simulation')

    const rates = document.createElement('div')
    rates.className = 'menu-rates'

    this.pauseButton = document.createElement('button')
    this.pauseButton.type = 'button'
    this.pauseButton.className = 'menu-key menu-pause'
    this.pauseButton.addEventListener('click', () => this.opts.onTogglePause())
    rates.appendChild(this.pauseButton)

    for (const speed of SPEEDS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'menu-key'
      b.textContent = formatSpeed(speed)
      b.title = `Simulation rate ${formatSpeed(speed)}`
      b.addEventListener('click', () => this.opts.onSpeed(speed))
      rates.appendChild(b)
      this.speedButtons.set(speed, b)
    }
    sim.appendChild(rates)

    this.soundBox = this.checkRow(sim, 'Interface sound', () => {
      this.opts.onToggleSound()
    })

    /* ---- display scheme ----------------------------------------------
       Named buttons rather than the old cycling toggle: with three schemes,
       picking the one you want beats pressing until it comes round. */

    const display = this.section('Display scheme')
    const schemes = document.createElement('div')
    schemes.className = 'menu-choices'
    for (const name of PALETTE_ORDER) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'menu-key menu-choice'
      b.textContent = PALETTE_LABEL[name]
      b.title = SCHEME_NOTE[name]
      b.addEventListener('click', () => this.opts.onPalette(name))
      schemes.appendChild(b)
      this.schemeButtons.set(name, b)
    }
    display.appendChild(schemes)

    /* ---- the session -------------------------------------------------- */

    // Above the overlays, because saving a shift is a bigger thing than
    // which layers are drawn -- and below the display scheme, because it is
    // not something you reach for every minute either.
    const session = this.section('Session')
    const buttons = document.createElement('div')
    buttons.className = 'menu-choices'
    for (const [label, run] of [
      ['SAVE', (): void => this.opts.onSave()],
      ['LOAD', (): void => this.opts.onLoad()],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'menu-key'
      b.textContent = label
      b.title =
        label === 'SAVE'
          ? 'Save the traffic, the clock and the score as they are'
          : 'Go back to the saved session'
      b.addEventListener('click', run)
      buttons.appendChild(b)
    }
    session.appendChild(buttons)

    /* ---- overlays ----------------------------------------------------- */

    const layers = this.section('Overlays')

    this.densityButton = document.createElement('button')
    this.densityButton.type = 'button'
    this.densityButton.className = 'menu-preset'
    this.densityButton.addEventListener('click', () => {
      this.opts.onOverlays(OVERLAY_PRESETS[nextDensity(densityOf(this.overlays))])
    })
    layers.appendChild(this.densityButton)

    for (const item of OVERLAY_ITEMS) {
      const box = this.checkRow(layers, item.label, (checked) => {
        this.opts.onOverlays({ ...this.overlays, [item.key]: checked })
      })
      this.overlayBoxes.set(item.key, box)
    }

    this.root.appendChild(this.panel)
    opts.mount.appendChild(this.root)

    // A menu closes when you go and do something else. Pointer down rather
    // than click, so dragging the scope dismisses it on the way past
    // instead of leaving it open over the picture.
    this.onDocumentPointerDown = (e: PointerEvent) => {
      if (!this.isOpen) return
      if (e.target instanceof Node && this.root.contains(e.target)) return
      this.setOpen(false)
    }
    this.onDocumentKeyDown = (e: KeyboardEvent) => {
      if (this.isOpen && e.key === 'Escape') this.setOpen(false)
    }
    document.addEventListener('pointerdown', this.onDocumentPointerDown)
    document.addEventListener('keydown', this.onDocumentKeyDown)

    this.paintOpen()
  }

  get element(): HTMLElement {
    return this.root
  }

  get open(): boolean {
    return this.isOpen
  }

  setOpen(open: boolean, silent = false): void {
    this.isOpen = open
    this.paintOpen()
    if (!silent) this.opts.onToggle?.(open)
  }

  toggle(): void {
    this.setOpen(!this.isOpen)
  }

  /** Releases the document listeners. Only tests need this. */
  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown)
    document.removeEventListener('keydown', this.onDocumentKeyDown)
    this.root.remove()
  }

  /**
   * Brings every control into line with the state that actually applies.
   * Called after any change, from wherever that change came from -- so the
   * keyboard shortcuts and the menu can never disagree.
   */
  paint(state: MenuState): void {
    this.overlays = state.overlays

    this.pauseButton.textContent = state.paused ? '>' : '||'
    this.pauseButton.title = state.paused ? 'Resume the simulation' : 'Pause the simulation'
    this.pauseButton.setAttribute('aria-pressed', String(state.paused))

    for (const [speed, button] of this.speedButtons) {
      // Paused is not a rate, so nothing is shown as the running rate
      // while the clock is stopped.
      mark(button, !state.paused && state.speed === speed)
    }

    this.soundBox.checked = !state.muted

    for (const [name, button] of this.schemeButtons) {
      mark(button, name === state.palette)
    }

    for (const [key, box] of this.overlayBoxes) box.checked = state.overlays[key]
    this.densityButton.textContent = `PRESET: ${densityOf(state.overlays).toUpperCase()}`
  }

  /* -------------------------------------------------------------- private */

  private section(heading: string): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'menu-section'
    const h = document.createElement('div')
    h.className = 'menu-heading'
    h.textContent = heading
    el.appendChild(h)
    this.panel.appendChild(el)
    return el
  }

  private checkRow(
    parent: HTMLElement,
    label: string,
    onChange: (checked: boolean) => void,
  ): HTMLInputElement {
    const row = document.createElement('label')
    row.className = 'menu-row'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.addEventListener('change', () => onChange(box.checked))
    row.appendChild(box)
    row.appendChild(document.createTextNode(label))
    parent.appendChild(row)
    return box
  }

  private paintOpen(): void {
    this.panel.hidden = !this.isOpen
    this.button.setAttribute('aria-expanded', String(this.isOpen))
    // A toolbar toggle of this era stayed pressed in while its panel was
    // showing, which is the whole affordance.
    this.button.classList.toggle('is-open', this.isOpen)
  }
}

/** Shared active-state painting for the pressed-in look. */
function mark(button: HTMLButtonElement, active: boolean): void {
  button.classList.toggle('is-active', active)
  button.setAttribute('aria-pressed', String(active))
}
