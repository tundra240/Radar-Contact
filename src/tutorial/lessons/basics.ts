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
 * Three rules the text follows, each learned from a way an earlier draft
 * failed a reader:
 *
 * - Name the control and the value. An earlier version said "or type
 *   BAW214 D30 S180 if you prefer the keyboard", and the command line had
 *   been taken out of the interface some time before -- so the lesson
 *   offered a way that did not exist beside a way it never described.
 * - Say why. "Descend to 3,000" is a thing to do; "3,000 because that is
 *   the platform every arrival meets the glidepath from" is a thing to
 *   learn, and the second transfers to the next aeroplane.
 * - Define the words. Downwind, final, localiser, glidepath: a lesson that
 *   uses them without saying what they mean is legible only to somebody who
 *   did not need it.
 *
 * The vectoring pattern is measured rather than assumed. From the BIG hold
 * the aircraft is about twenty miles east of the threshold and ten south of
 * the extended centreline; the localiser captures only within a mile and a
 * half of that centreline, inside twenty-five miles, within thirty degrees
 * of the runway heading, and at or below three thousand feet. Turning west
 * and then onto a thirty-degree intercept satisfies all four. A final turn
 * onto 270 would not -- from ten miles to one side it runs parallel to the
 * beam and never reaches it.
 */
export const BASICS: TutorialModule = {
  id: 'basics',
  // Heathrow, always. The holds, the runway and every heading below are
  // facts about this field; see TutorialModule.airport.
  airport: 'EGLL',
  title: 'Approach control: the basics',
  summary: 'The scope, the hold, a vectored ILS, the ATIS, transits and weather.',
  steps: [
    /* ---- phase 1: the display, with the clock stopped ------------------ */
    {
      id: 'welcome',
      title: 'Welcome to London Terminal Control',
      text:
        'You are working Heathrow approach. The white outline is your airspace: inside it ' +
        'the traffic is yours, outside it belongs to somebody else. The job is to take ' +
        'arrivals from the edge of it and deliver them to the runway, in order and far ' +
        'enough apart. The clock is stopped, so nothing moves until you let it. ' +
        'Press Continue.',
      spotlight: { kind: 'scope' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: { paused: true, traffic: [], weather: [] },
    },
    {
      id: 'time',
      title: 'The clock',
      text:
        'Two controls on the rail, both highlighted, and the RATE readout along the top ' +
        'that shows what they are set to. The upper button stops and starts the clock. ' +
        'The lower one steps the rate -- x1, x2, x4, x0.5 and round again. Speeding up is ' +
        'how you skip the quiet minutes; stopping is how you think. Press Continue.',
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'elements', selectors: ['.pause-button', '.rate-button'] },
          { kind: 'readout', label: 'RATE' },
        ],
      },
      goal: { kind: 'continue' },
      button: 'Continue',
    },

    /* ---- phase 2: an arrival, and the hold ----------------------------- */
    {
      id: 'inbound',
      title: 'An inbound',
      text:
        'BAW214 has appeared south-east of the field at 10,000 feet, tracking to BIG. It ' +
        'needs about seven minutes to get there, which is a long time to watch. Press the ' +
        'rate button until the RATE readout says x4, and let it run in.',
      // The aircraft, the button, and the readout that answers the question
      // the step asks. Dimming the aeroplane it says to watch would be the
      // wrong way round.
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'aircraft', ref: 'inbound' },
          { kind: 'elements', selectors: ['.rate-button'] },
          { kind: 'readout', label: 'RATE' },
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
        'Nothing to press. Reaching BIG with no further clearance, BAW214 turns onto the ' +
        'published racetrack and orbits -- a one-minute leg each way, so about two ' +
        'minutes round. An aircraft holds because it has arrived before there is room for ' +
        'it, and it will keep holding until you say otherwise. The clock stops by itself ' +
        'once it is established.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'holding', ref: 'inbound' },
      button: null,
      // Stopped the moment it is established, so the pattern can be looked
      // at rather than flown past while the instruction is being read.
      pauseOnGoal: true,
    },
    {
      id: 'hold-read',
      title: 'The four holds, and how they feed the airport',
      text:
        'Heathrow has four, one to each quadrant, and which one an arrival uses depends on ' +
        'where it flew in from: BNN north-west for the Atlantic, LAM north-east for ' +
        'northern Europe, BIG south-east for the Middle East and Asia, OCK south-west for ' +
        'Iberia. Each is a queue. Aircraft stack over one a thousand feet apart, lowest ' +
        'first, and you take them off the bottom -- which is how four separate streams ' +
        'become one line of traffic for one runway. Press Continue.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'continue' },
      button: 'Continue',
    },

    /* ---- phase 3: working the aircraft --------------------------------- */
    {
      id: 'select',
      title: 'Selecting an aircraft',
      text:
        'LEFT-click BAW214 -- either the small square or the block of text beside it. The ' +
        'square fills in to show which one you are working, and its strip lights up in ' +
        'the bay on the right. The clock is running again from here.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'select', ref: 'inbound' },
      button: null,
      scene: { paused: false, speed: 1 },
    },
    {
      id: 'descend',
      title: 'Descent and speed',
      text:
        'RIGHT-click BAW214 for its command menu. Choose ALTITUDE, then 3000: that is the ' +
        'platform every arrival levels at to meet the glidepath from underneath, and one ' +
        'left higher flies over the beam instead of catching it. Right-click again, ' +
        'choose SPEED, and pick 180 -- slower traffic covers less ground per minute, ' +
        'which is time you get back to arrange everything else.',
      // The menu as well, once it is open. It is not in the document until
      // the right-click, and a hole around something absent is no hole.
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'aircraft', ref: 'inbound' },
          { kind: 'elements', selectors: ['.tagmenu'] },
        ],
      },
      goal: {
        kind: 'every',
        of: [
          { kind: 'altitude', ft: 3000, ref: 'inbound' },
          { kind: 'airspeed', kts: 180, ref: 'inbound' },
        ],
      },
      button: null,
    },

    /* ---- phase 4: the ATIS, and getting it onto the ILS ---------------- */
    {
      id: 'atis',
      title: 'The ATIS, and the words for the pattern',
      text:
        'The board on the left says ARR 27R: arrivals land on runway 27R, which points ' +
        'west, so they fly the last few miles heading 270. That straight run in is the ' +
        'FINAL. The radio beam along it is the LOCALISER, which steers left and right; ' +
        'the GLIDEPATH is its partner and steers the descent. Everything you do with an ' +
        'arrival is aimed at putting it on that beam, low enough and shallow enough to ' +
        'catch it. Press Continue.',
      spotlight: { kind: 'elements', selectors: ['.atis-button', '.atis-box'] },
      goal: { kind: 'continue' },
      button: 'Continue',
    },
    {
      id: 'turn-in',
      title: 'Turn it towards the airport',
      text:
        'Headings are dragged, not picked from a list. Press and hold on BAW214, pull the ' +
        'elastic line out to the WEST -- left, towards the field -- and let go on 270. ' +
        'That takes it out of the hold and points it at the airport. The clock stops as ' +
        'it turns, so there is no hurry over the next card.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'heading', deg: 270, ref: 'inbound' },
      button: null,
      // The intercept below has a geometry window about ninety seconds wide
      // at this range. Stopping the clock here takes the clock out of the
      // problem, so the next card can be read rather than raced.
      pauseOnGoal: true,
    },
    {
      id: 'intercept',
      title: 'Intercept the beam at an angle',
      text:
        'BAW214 is about ten miles south of the final approach track, so 270 keeps it ' +
        'parallel and it would never reach the beam. Drag it onto 300 instead -- thirty ' +
        'degrees right of the runway heading. A shallow angle like that is the only way ' +
        'to catch a localiser: come at it steeper and the aircraft crosses faster than it ' +
        'can turn, and flies straight through.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'heading', deg: 300, ref: 'inbound' },
      button: null,
    },
    {
      id: 'clear-ils',
      title: 'Cleared for the approach',
      text:
        'RIGHT-click BAW214, choose APPROACH, then ILS 27R. Clearing it before it reaches ' +
        'the beam is correct: the clearance only ARMS the approach, and the aircraft waits ' +
        'until the geometry is right before turning on. After that it flies the localiser ' +
        'and the glidepath to the runway without another word from you.',
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'aircraft', ref: 'inbound' },
          { kind: 'elements', selectors: ['.tagmenu'] },
        ],
      },
      goal: { kind: 'approach', ref: 'inbound' },
      button: null,
      resetOn: ['goAround'],
      scene: { paused: false, speed: 1 },
    },

    /* ---- phase 5: traffic that is not yours ---------------------------- */
    {
      id: 'transit',
      title: 'Traffic crossing the sector',
      text:
        'EZY63 is not yours to land: a Gatwick inbound crossing at FL140 on its own flight ' +
        'plan. It is steel blue rather than green, and its data block carries EGKK where ' +
        'an arrival carries nothing. It wants no instruction from you -- but it is in your ' +
        'airspace, so it counts for separation and it occupies the levels it passes ' +
        'through. Press Continue.',
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
          },
        ],
      },
    },
    {
      id: 'resume-nav',
      title: 'Vector it, then give it back',
      text:
        'Two aircraft are separated if they are 3 miles apart OR 1,000 feet apart -- ' +
        'either alone is enough, which is why a stack over one fix is legal. Drag EZY63 ' +
        'onto any heading, as you would to move it out of the way of something. Then ' +
        'RIGHT-click it and choose RESUME NAV: that hands its flight plan back, so you are ' +
        'not flying it by hand for the rest of its crossing.',
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'aircraft', ref: 'transit' },
          { kind: 'elements', selectors: ['.tagmenu'] },
        ],
      },
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
        'A cell has grown over OCK, south-west of the field. Three bands: faint at the ' +
        'edge, brighter through the middle, red in the core. Red is severe turbulence -- ' +
        'an aircraft vectored into it calls up asking to be taken out, and its target goes ' +
        'red until you do. Cells drift and fade on their own, so a gap you plan through ' +
        'now may not be there in ten minutes. Press Continue.',
      // Wide enough for the whole cell rather than the navaid under it: the
      // storm is seven miles across and its shape is the point of the step.
      spotlight: { kind: 'fix', name: 'OCK', radiusNM: 9 },
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
        'Three arrivals, a storm over OCK, one runway. For each: descend it to 3000 and ' +
        'slow it, drag it onto 270 and then onto 300 to intercept, then APPROACH and ILS ' +
        '27R. Land all three. Keep every pair 3 miles or 1,000 feet apart the whole way, ' +
        'and keep them out of the red. Lose separation and the step starts again.',
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
