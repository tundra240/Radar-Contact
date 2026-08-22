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

function mount(atis: Atis, runways: readonly RunwayFace[] = FACES) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const changes: { arrivals: readonly string[]; departures: readonly string[] }[] = []
  const bar = new AtisBar({ mount: host, onChange: (next) => changes.push(next) })
  bars.push(bar)
  bar.paint({ atis, runways })
  return {
    host,
    bar,
    changes,
    button: host.querySelector<HTMLButtonElement>('.atis-button')!,
    panel: host.querySelector<HTMLDivElement>('.atis-panel')!,
    choices: () => [...host.querySelectorAll<HTMLButtonElement>('.atis-choice')],
    advice: host.querySelector<HTMLParagraphElement>('.atis-advice')!,
  }
}

const START = makeAtis({ arrivals: ['27R', '27L'], departures: ['27R'], wind: WESTERLY })

describe('the ticker', () => {
  it('reads out the letter, the runways and the wind', () => {
    const ui = mount(START)
    expect(ui.button.textContent).toBe('INFO A  ARR 27R/27L  DEP 27R  250/18')
  })

  it('follows the broadcast when it is amended', () => {
    const ui = mount(START)
    ui.bar.paint({ atis: amend(START, { arrivals: ['09L', '09R'] }), runways: FACES })
    expect(ui.button.textContent).toContain('INFO B')
    expect(ui.button.textContent).toContain('ARR 09L/09R')
  })

  it('starts closed and opens on a press', () => {
    const ui = mount(START)
    expect(ui.panel.hidden).toBe(true)
    ui.button.click()
    expect(ui.panel.hidden).toBe(false)
  })

  it('closes on Escape and on a click elsewhere', () => {
    const ui = mount(START)
    ui.button.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(ui.panel.hidden).toBe(true)

    ui.button.click()
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(ui.panel.hidden).toBe(true)
  })
})

describe('choosing a direction', () => {
  it('offers each direction once, not each runway', () => {
    // A field chooses a direction; every parallel in it comes along.
    const ui = mount(START)
    const names = ui.choices().map((b) => b.querySelector('.atis-choice-name')?.textContent)
    expect(names).toEqual(['27R/27L', '09L/09R', '27R/27L', '09L/09R'])
  })

  it('marks the direction in use as pressed in', () => {
    const ui = mount(START)
    const landing = ui.choices()[0]!
    expect(landing.classList.contains('is-on')).toBe(true)
    expect(ui.choices()[1]!.classList.contains('is-on')).toBe(false)
  })

  it('reports the whole new configuration, not just the half that changed', () => {
    // main.ts amends one ATIS value; a callback naming only the arrivals
    // would leave the caller guessing at the departures.
    const ui = mount(START)
    ui.choices()[1]!.click()
    expect(ui.changes).toEqual([{ arrivals: ['09L', '09R'], departures: ['27R'] }])
  })

  it('changes the departure runways on their own', () => {
    const ui = mount(START)
    // Third and fourth buttons are the departure row.
    ui.choices()[3]!.click()
    expect(ui.changes).toEqual([{ arrivals: ['27R', '27L'], departures: ['09L', '09R'] }])
  })

  it('shows the wind on each face, so the choice is informed', () => {
    const ui = mount(START)
    const text = ui.choices()[0]!.textContent ?? ''
    expect(text).toContain('head')
    expect(ui.choices()[1]!.textContent).toContain('TAIL')
  })

  it('marks a downwind direction on the button itself', () => {
    // Where the mistake would be made, rather than only in the advice line.
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
  it('lets go of its document listeners when destroyed', () => {
    const ui = mount(START)
    ui.button.click()
    ui.bar.destroy()
    // Nothing left in the document to receive the event, and no throw.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.atis')).toBeNull()
  })
})
