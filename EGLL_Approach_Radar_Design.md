# Radar Ops: London Approach (EGLL)
## Technical Game Design & Development Specification (3-Day Build)

---

## 1. Executive Summary & Vision

**Radar Ops** is a fast-paced, tactical 2D Air Traffic Control (ATC) approach radar simulation inspired by early-to-mid 2000s automated radar terminal system (ARTS/STARS) and Eurocat/TopSky style glass-cockpit displays. 

Rather than simulating vintage monochrome circular sweeps, the game features a sleek, high-contrast digital display with crisp vector tracks, speed vectors, altitude trend arrows, interactive flight progress strips, and structured airspaces.

The player assumes the role of an **Approach Controller (Terminal Control)** handling arrivals into **London Heathrow Airport (EGLL)**. The goal is to vector incoming flights safely, sequence them onto the twin parallel runways (Runway 27R and 27L), maintain strict separation, and maximize landing rate under increasing traffic density.

---

## 2. Visual Style & Aesthetic (2000s Glass Terminal Interface)

* **Radar Screen:** Dark charcoal slate beige background (), crisp neon teal/cyan sector boundaries, terminal control area (TMA) arrival hold stacks, and subtle distance range rings (5, 10, 15, 20 NM).
* **Aircraft Targets (Blips):** Solid filled squares or diamond markers with 3-dot fading history trails showing ground track vector lines.
* **Data Blocks (Leader Lines):** Connected to each blip by an adjustable leader line containing:
  * **Line 1:** Callsign (e.g., `BAW178`, `VIR45`) + Aircraft Heavy Indicator (`H`).
  * **Line 2:** Mode-C Altitude (hundreds of feet, e.g., `040` = 4,000 ft) + Altitude Trend Arrow (`↓` / `↑` / `=`) + Cleared Altitude.
  * **Line 3:** Groundspeed in knots (e.g., `210`) + Assigned Speed.
* **Color Palette:**
  * **Controlled Inbounds:** Crisp Green / Teal (`#00e676` or `#00e5ff`).
  * **Selected Aircraft:** High-visibility Bright Yellow (`#ffea00`).
  * **Conflict Warning / Separation Loss:** Flashing Crimson Red (`#ff1744`).
  * **Established on ILS:** Soft Cyan (`#18ffff`).
  * **Flight Strip Bay:** Dark grey metallic side panel (`#1e2530`) with grouped arrival/departure cards.

---

## 3. Core Gameplay Loop & Mechanics

```
[Arrival Spawns at Waypoint/Hold] 
               │
               ▼
   [Player Assigns Vectors/Alt/Speed]
               │
               ▼
  [Sequence onto Extended Centerline]
               │
               ▼
[Capture ILS Localizer & Glideslope]
               │
               ▼
     [Auto-Descend to Runway]
               │
               ▼
    [Hand-Off / Score Points]
```

### Key Rules & Physics
1. **Lateral Separation:** Maintain minimum **3.0 Nautical Miles (NM)** horizontally between all airborne radar targets.
2. **Vertical Separation:** Maintain minimum **1,000 feet** vertically when horizontal separation is less than 3.0 NM.
3. **ILS Localizer Intercept:**
   * Aircraft must intercept the extended centerline at an angle of **$\le 30^\circ$ relative to runway heading**.
   * Intercept altitude must be **at or below 3,000 ft AMSL** prior to the Final Approach Fix (FAF).
4. **Speed Limits:** Terminal maneuvering area speed limit below FL100 is 250 knots unless cleared higher.

---

## 4. UI Architecture & Screen Layout

```
+---------------------------------------------------+--------------------+
|                                                   | FLIGHT STRIP BAY   |
|                 (LAM VOR Hold)                    |                    |
|                       ( )                         | [BAW178] A320      |
|                                                   | FL100 -> 3000      |
|                                                   | HDG: 270 | SPD: 210|
|         BAW178 H                                  | STATUS: VECTORING  |
|         040↓30 210                                | ------------------ |
|           •---->                                  | [VIR045] B789 (H)  |
|                                                   | FL120 -> 4000      |
|                     [EGLL 27R]                    | HDG: 240 | SPD: 220|
|                   =============                   | STATUS: IN HOLD    |
|                     [EGLL 27L]                    | ------------------ |
|                   =============                   | [SWR318] A321      |
|                                                   | ESTABLISHED ILS 27R|
|                       ( )                         |                    |
|                 (BIG VOR Hold)                    | COMMAND CONSOLE    |
|                                                   | > BAW178 HDG 270   |
+---------------------------------------------------+--------------------+
```

### Control Interaction Modes
1. **Mouse / Direct Screen Interaction (Primary):**
   * **Left Click Aircraft:** Select target and display quick-action vector ring / radial wheel.
   * **Click & Drag Vector Line:** Rubber-band a heading vector arrow straight out from the plane to command new heading.
   * **Scroll Wheel over Data Block:** Quick-adjust target altitude or target speed.
2. **Interactive Flight Progress Strips:**
   * Located in the collapsible right-side bay.
   * Clicking a strip highlights the corresponding radar target immediately.
   * Quick-buttons on strip: `[DES 3000]`, `[SPD 160]`, `[CLEARED ILS]`.
3. **Keyboard Shortcuts / Command Bar (For Power Players):**
   * Direct command input: `BAW178 H270 A30 S180` (BAW178 turn heading 270, descend 3,000ft, reduce speed 180kts).

---

## 5. London Heathrow (EGLL) Sector Configuration

* **Runways:** Parallel **27R** (Primary Inbound) and **27L** (Secondary Inbound/Outbound).
* **Approach Entry Holds / Feeder Fixes:**
  * **LAM (Lambourne):** North-East entry fix.
  * **BIG (Biggin):** South-East entry fix.
  * **BOVN (Bovingdon):** North-West entry fix.
  * **OCK (Ockham):** South-West entry fix.
* **Transition Altitudes:** Sector Ceiling at **FL150 (15,000 ft)** down to **2,500 ft** initial intercept altitude.

---

## 6. Modular Expansion Architecture (Future Multi-Airport System)

To support seamless addition of new airports (e.g., EGKK Gatwick, EGGW Luton, KJFK New York, VHHH Hong Kong) post-MVP, the code uses a JSON configuration pattern:

```json
{
  "airport_icao": "EGLL",
  "name": "London Heathrow",
  "runways": [
    {
      "identifier": "27R",
      "heading": 272,
      "length_px": 80,
      "threshold_pos": [450, 400],
      "ils_available": true
    },
    {
      "identifier": "27L",
      "heading": 272,
      "length_px": 80,
      "threshold_pos": [450, 430],
      "ils_available": true
    }
  ],
  "entry_fix_points": [
    {"name": "LAM", "pos": [700, 150]},
    {"name": "BIG", "pos": [700, 650]},
    {"name": "BOVN", "pos": [150, 150]},
    {"name": "OCK", "pos": [150, 650]}
  ]
}
```

---

## 7. 3-Day Development Roadmap

### Day 1: Radar Screen, Physics & Rendering Engine
* Establish dark 2000s digital radar canvas with grid, scale range rings, and EGLL runway coordinates.
* Implement target physics engine: position updates, vector math ($\Delta x = v \cdot \sin(	heta)$, $\Delta y = -v \cdot \cos(	heta)$), turn rates ($3^\circ$/sec), and altitude change rates ($1500$ ft/min).
* Render target data blocks with leader lines and fading trail histories.

### Day 2: Flight Strips, Mouse Controls & ILS Mechanics
* Build the right-side Flight Progress Strip panel with synchronized state tracking.
* Implement click-and-drag vector arrow control and mouse wheel altitude changes.
* Build the ILS capture cone detection logic (checking distance, intercept angle $\le 30^\circ$, and altitude $\le 3,000$ ft).

### Day 3: Conflict Detection, Audio, Spawner & Polish
* Implement 3.0 NM / 1,000 ft separation loss detection with flashing crimson alert rings.
* Build automated arrival traffic spawner with randomized entry fix assignments and flight plans.
* Add retro radio chimes/beeps, landing score tracker, and game-over / summary screen.
