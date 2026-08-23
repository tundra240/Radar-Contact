import type { TutorialModule } from '../types'

/**
 * The first lesson: everything a controller needs before they are left
 * alone with the sector.
 *
 * This file is data. There is no code in it and there is not meant to be:
 * it is the demonstration that a lesson can be written without touching the
 * engine, the simulation or the interface, and the moment one of those has
 * to change to add a step, the model in types.ts is wrong rather than the
 * lesson.
 *
 * The shape of it is six phases -- look at the display, watch one arrival
 * hold, work that arrival onto the ILS, meet the ATIS, meet the traffic
 * that is not yours, and then do the whole thing at once with weather in
 * the way.
 */
export const BASICS: TutorialModule = {
  id: 'basics',
  title: 'Approach control: the basics',
  summary: 'The scope, the hold, a vectored ILS, the ATIS, transits and weather.',
  steps: [
    /* ---- phase 1: the display, with the clock stopped ------------------ */
    {
      id: 'welcome',
      title: 'Welcome to London Terminal Control',
      text:
        'This is Heathrow approach. The scope shows your airspace, the four entry fixes ' +
        'aircraft arrive over -- BNN, OCK, LAM and BIG -- and the runways in use. ' +
        'Nothing moves until you let it.',
      spotlight: { kind: 'scope' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: { paused: true, traffic: [], weather: [] },
    },
    {
      id: 'time',
      title: 'Time controls',
      text:
        'Traffic moves faster than you will want to read at first. The rate button steps ' +
        'through the speeds and wraps round; the one above it stops the clock. Both are on ' +
        'the rail down the left.',
      spotlight: { kind: 'elements', selectors: ['.rate-button', '.pause-button'] },
      goal: { kind: 'continue' },
      button: 'Continue',
    },

    /* ---- phase 2: an arrival, and the hold ----------------------------- */
    {
      id: 'inbound',
      title: 'An inbound',
      text:
        'A flight has entered the sector at BIG, 10,000 feet and 250 knots. It is tracking ' +
        'direct to the fix on its own. Wind the clock on to 4x and watch it get there.',
      // The aircraft as well as the control: the instruction is about
      // watching one while pressing the other, and dimming the aeroplane
      // the step is asking you to watch would be the wrong way round.
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'aircraft', ref: 'inbound' },
          { kind: 'elements', selectors: ['.rate-button'] },
        ],
      },
      goal: { kind: 'speed', to: 4 },
      button: null,
      scene: {
        paused: false,
        speed: 1,
        traffic: [
          {
            ref: 'inbound',
            kind: 'arrival',
            fix: 'BIG',
            altFt: 10000,
            iasKts: 250,
            callsign: 'BAW214',
            type: 'A320',
          },
        ],
      },
    },
    {
      id: 'hold',
      title: 'The holding pattern',
      text:
        'Reaching BIG with no further clearance, the flight has entered the published hold ' +
        'and will orbit there until you do something about it. A racetrack with a ' +
        'one-minute inbound leg, so about two minutes round. This is where arrivals wait ' +
        'for a runway.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'holding', ref: 'inbound' },
      button: null,
      // Stopped the moment it is established, so the pattern can be looked
      // at rather than flown past while the instruction is being read.
      pauseOnGoal: true,
    },
    {
      id: 'hold-read',
      title: 'Reading the stack',
      text:
        'Aircraft stack over a fix a thousand feet apart, and that vertical gap is what ' +
        'keeps them separated while they are all over the same point. Take the clock off ' +
        'pause when you are ready.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'continue' },
      button: 'Continue',
    },

    /* ---- phase 3: working the aircraft --------------------------------- */
    {
      id: 'select',
      title: 'Selecting an aircraft',
      text:
        'Click the target or its data block to select it. Its strip is highlighted in the ' +
        'bay on the right, and right-clicking opens the command menu.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'select', ref: 'inbound' },
      button: null,
      scene: { paused: false, speed: 1 },
    },
    {
      id: 'descend',
      title: 'Descent and speed',
      text:
        'Bring it down to 3,000 feet -- the level it needs to be at to intercept the ' +
        'glidepath -- and slow it to 180 knots. Right-click the target for the menu, or ' +
        'type BAW214 D30 S180 if you prefer the keyboard.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: {
        kind: 'every',
        of: [
          { kind: 'altitude', ft: 3000, ref: 'inbound' },
          { kind: 'airspeed', kts: 180, ref: 'inbound' },
        ],
      },
      button: null,
    },
    {
      id: 'downwind',
      title: 'Vectoring off the hold',
      text:
        'Press on the target and drag: an elastic line follows the cursor and lets go as a ' +
        'heading. Take it out of the hold onto 090, which is downwind for 27R.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'heading', deg: 90, ref: 'inbound' },
      button: null,
    },

    /* ---- phase 4: the ATIS and the ILS --------------------------------- */
    {
      id: 'atis',
      title: 'The ATIS',
      text:
        'The board on the left carries the current letter, the wind and the runways in ' +
        'use. The wind decides the direction the field runs in, and everything you do with ' +
        'an arrival is aimed at the runway it names. Aircraft need to meet the localiser ' +
        'at less than 30 degrees to capture it.',
      spotlight: { kind: 'elements', selectors: ['.atis-button', '.atis-box'] },
      goal: { kind: 'continue' },
      button: 'Continue',
    },
    {
      id: 'base',
      title: 'Base leg',
      text:
        'Turn it north onto 360 to come off downwind, then onto 240 to close on the 27R ' +
        'localiser from the south. Thirty degrees off the final approach track is a ' +
        'capture; ninety degrees is a fly-through.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: {
        kind: 'inOrder',
        of: [
          { kind: 'heading', deg: 360, ref: 'inbound' },
          { kind: 'heading', deg: 240, ref: 'inbound' },
        ],
      },
      button: null,
    },
    {
      id: 'clear-ils',
      title: 'Cleared for the approach',
      text:
        'On an intercept heading and at 3,000 feet, clear it for the ILS. The approach ' +
        'arms; the aircraft captures the localiser when the geometry actually allows it ' +
        'and follows the glidepath down from there.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'approach', ref: 'inbound' },
      button: null,
      resetOn: ['goAround'],
    },

    /* ---- phase 5: traffic that is not yours ---------------------------- */
    {
      id: 'transit',
      title: 'Traffic crossing the sector',
      text:
        'This one is not yours to land. It is a Gatwick inbound crossing at FL140 on its ' +
        'own flight plan, drawn in steel blue so you can tell at a glance. It needs ' +
        'nothing from you -- but it is in your airspace, and it counts for separation.',
      spotlight: { kind: 'aircraft', ref: 'transit' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: {
        paused: false,
        speed: 1,
        traffic: [
          {
            ref: 'transit',
            kind: 'overflight',
            corridor: 'KK-EAST',
            altFt: 14000,
            iasKts: 280,
            callsign: 'EZY63',
            type: 'A320',
          },
        ],
      },
    },
    {
      id: 'resume-nav',
      title: 'Vector it, then give it back',
      text:
        'Separation is 3 nautical miles or 1,000 feet -- either one, not both. Vector the ' +
        'transit off its track as though something were in the way, then give it back its ' +
        'flight plan with RESUME NAV on its menu, or type EZY63 NAV.',
      spotlight: { kind: 'aircraft', ref: 'transit' },
      goal: {
        kind: 'inOrder',
        of: [
          { kind: 'vector', ref: 'transit' },
          { kind: 'resumeNav', ref: 'transit' },
        ],
      },
      button: null,
    },

    /* ---- phase 6: weather, and doing it all at once -------------------- */
    {
      id: 'weather',
      title: 'Weather',
      text:
        'A cell has developed over OCK. The bands are painted light, moderate and red, and ' +
        'the red core is the one that matters: an aircraft vectored into it asks you to get ' +
        'it out. Plan round it rather than through it.',
      spotlight: { kind: 'fix', name: 'OCK' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: {
        paused: true,
        traffic: [],
        weather: [{ overFix: 'OCK', radiusNM: 7, peak: 0.95, lifeMinutes: 45 }],
      },
    },
    {
      id: 'checkride',
      title: 'Checkride',
      text:
        'Three arrivals, a storm over OCK and one runway. Vector them round the weather, ' +
        'keep them apart, and land all three on 27R. Lose separation and the step starts ' +
        'again.',
      spotlight: { kind: 'none' },
      goal: { kind: 'allLanded' },
      button: null,
      resetOn: ['conflict', 'goAround'],
      scene: {
        paused: false,
        speed: 1,
        weather: [{ overFix: 'OCK', radiusNM: 7, peak: 0.95, lifeMinutes: 45 }],
        traffic: [
          {
            ref: 'one',
            kind: 'arrival',
            fix: 'BIG',
            altFt: 9000,
            iasKts: 250,
            callsign: 'BAW51',
            type: 'A320',
          },
          {
            ref: 'two',
            kind: 'arrival',
            fix: 'BIG',
            altFt: 11000,
            iasKts: 250,
            callsign: 'VIR12',
            type: 'A359',
          },
          {
            ref: 'three',
            kind: 'arrival',
            fix: 'OCK',
            altFt: 10000,
            iasKts: 250,
            callsign: 'EIN802',
            type: 'A320',
          },
        ],
      },
    },
  ],
}
