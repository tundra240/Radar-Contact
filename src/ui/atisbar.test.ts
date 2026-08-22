// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { amend, makeAtis, type Atis, type RunwayFace } from '../sim/atis'
import { AtisBar } from './atisbar'

const FACES: RunwayFace[] = [
  { id: '27R', bearingTrue: 270, thresholdNM: { x: 1, y: 0.42 } },
  { id: '27L', bearingTrue: 270, thresholdNM: { x: 0.97, y: -0.35 } },
  { id: '09L', bearingTrue: 90, thresholdNM: { x: -1.1, y: 0.4 } },
  { id: '09R', bearingTrue: 90, thresholdNM: { x: -1.01, y: -0.36 } },
]

const WESTERLY = { fromDeg: 250, speedKts: 18 }

let bars: AtisBar[] = []

afterEach(() => {
  for (const bar of bars) bar.destroy()
  bars = []
  document.body.replaceChildren()
})

function mount(atis: Atis, runways: readonly RunwayFace[] = FACES, open?: boolean) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const changes: { arrivals: readonly string[]; departures: readonly string[] }[] = []
  const toggles: boolean[] = []
  const bar = new AtisBar({
    mount: host,
    onChange: (next) => changes.push(next),
    onToggle: (o) => toggles.push(o),
    ...(open === undefined ? {} : { open }),
  })
  bars.push(bar)
  bar.paint({ atis, runways })
  const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)!
  return {
    host,
    bar,
    changes,
    toggles,
    button: q<HTMLButtonElement>('.atis-button'),
    box: q<HTMLDivElement>('.atis-box'),
    letter: q<HTMLDivElement>('.atis-letter'),
    values: () => [...host.querySelectorAll('.atis-readout dd')].map((d) => d.textContent),
    choices: () => [...host.querySelectorAll<HTMLButtonElement>('.atis-choice')],
    advice: q<HTMLParagraphElement>('.atis-advice'),
  }
}

const START = makeAtis({ arrivals: ['27R', '27L'], departures: ['27R'], wind: WESTERLY })

describe('the board', () => {
  it('is a compact button, not a strip of text', () => {
    // The readout belongs on the board; the toolbar gets a word, like WX.
    expect(mount(START).button.textContent).toBe('ATIS')
  })

  it('shows the letter, both runway sets and the wind', () => {
    const ui = mount(START)
    expect(ui.letter.textContent).toBe('INFORMATION ALPHA')
    expect(ui.values()).toEqual(['27R / 27L', '27R', '250/18'])
  })

  it('follows the broadcast when it is amended', () => {
    const ui = mount(START)
    ui.bar.paint({ atis: amend(START, { arrivals: ['09L', '09R'] }), runways: FACES })
    expect(ui.letter.textContent).toBe('INFORMATION BRAVO')
    expect(ui.values()[0]).toBe('09L / 09R')
  })

  it('says so rather than going blank when nothing is in use', () => {
    const shut = makeAtis({ arrivals: [], departures: [], wind: WESTERLY })
    expect(mount(shut).values()).toEqual(['--', '--', '250/18'])
  })
})

describe('the toggle', () => {
  it('starts shown, with the button reading as pressed in', () => {
    const ui = mount(START)
    expect(ui.box.hidden).toBe(false)
    expect(ui.button.classList.contains('is-on')).toBe(true)
  })

  it('can be asked to start hidden', () => {
    const ui = mount(START, FACES, false)
    expect(ui.box.hidden).toBe(true)
    expect(ui.button.classList.contains('is-on')).toBe(false)
  })

  it('hides and shows on the button, and reports each way', () => {
    const ui = mount(START)
    ui.button.click()
    expect(ui.box.hidden).toBe(true)
    ui.button.click()
    expect(ui.box.hidden).toBe(false)
    expect(ui.toggles).toEqual([false, true])
  })

  it('stays up when you click on the scope', () => {
    // The whole difference between a board and a menu. A readout that
    // vanished the moment you touched an aircraft would be one you could
    // never use while working.
    const ui = mount(START)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(ui.box.hidden).toBe(false)
  })

  it('keeps its readout current while hidden', () => {
    // So it is right the instant it comes back, rather than a frame stale.
    const ui = mount(START, FACES, false)
    ui.bar.paint({ atis: amend(START, { arrivals: ['09L', '09R'] }), runways: FACES })
    ui.button.click()
    expect(ui.values()[0]).toBe('09L / 09R')
  })
})

describe('choosing a direction', () => {
  it('offers each direction once, not each runway', () => {
    const ui = mount(START)
    const names = ui.choices().map((b) => b.querySelector('.atis-choice-name')?.textContent)
    expect(names).toEqual(['27R/27L', '09L/09R', '27R/27L', '09L/09R'])
  })

  it('marks the direction in use as pressed in', () => {
    const ui = mount(START)
    expect(ui.choices()[0]!.classList.contains('is-on')).toBe(true)
    expect(ui.choices()[1]!.classList.contains('is-on')).toBe(false)
  })

  it('reports the whole new configuration, not just the half that changed', () => {
    const ui = mount(START)
    ui.choices()[1]!.click()
    expect(ui.changes).toEqual([{ arrivals: ['09L', '09R'], departures: ['27R'] }])
  })

  it('changes the departure runways on their own', () => {
    const ui = mount(START)
    ui.choices()[3]!.click()
    expect(ui.changes).toEqual([{ arrivals: ['27R', '27L'], departures: ['09L', '09R'] }])
  })

  it('shows the wind on each face, so the choice is informed', () => {
    const ui = mount(START)
    expect(ui.choices()[0]!.textContent).toContain('head')
    expect(ui.choices()[1]!.textContent).toContain('TAIL')
  })

  it('marks a downwind direction on the button itself', () => {
    const ui = mount(START)
    expect(ui.choices()[1]!.classList.contains('is-tailwind')).toBe(true)
    expect(ui.choices()[0]!.classList.contains('is-tailwind')).toBe(false)
  })
})

describe('the advice line', () => {
  it('says nothing is wrong when landing into wind', () => {
    const ui = mount(START)
    expect(ui.advice.textContent).toContain('Landing into wind')
    expect(ui.advice.classList.contains('is-warning')).toBe(false)
  })

  it('warns when the tailwind is over the limit, and names the alternative', () => {
    const wrong = makeAtis({
      arrivals: ['27R', '27L'],
      departures: ['27R'],
      wind: { fromDeg: 90, speedKts: 15 },
    })
    const ui = mount(wrong)
    expect(ui.advice.classList.contains('is-warning')).toBe(true)
    expect(ui.advice.textContent).toContain('Tailwind')
    expect(ui.advice.textContent).toContain('09L/09R')
  })

  it('says so when the field is landing nothing', () => {
    const shut = makeAtis({ arrivals: [], departures: [], wind: WESTERLY })
    const ui = mount(shut)
    expect(ui.advice.classList.contains('is-warning')).toBe(true)
    expect(ui.advice.textContent).toContain('No approach can be cleared')
  })

  it('survives a field with only one direction', () => {
    const one = FACES.filter((f) => f.id === '27R')
    const ui = mount(makeAtis({ arrivals: ['27R'], departures: ['27R'], wind: WESTERLY }), one)
    expect(ui.advice.textContent).toContain('One direction available')
  })
})

describe('housekeeping', () => {
  it('takes itself off the page when destroyed', () => {
    const ui = mount(START)
    ui.bar.destroy()
    expect(document.querySelector('.atis')).toBeNull()
  })
})
