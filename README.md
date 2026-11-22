# Chroma Hunt

A camera party game for phones. Everyone gets the same colour, then races to find
**something real** that matches it. Aim the scope, watch the meter climb, and snap
once. The game scores how close the colours look (CIEDE2000 in CIELAB) and how
quickly you snapped, and everyone's photos go up side by side on the big screen.

2–10 players, plus an optional big screen at `?tv`. Works solo too, including
**Today's palette**: the same five colours for everyone today.

Live at <https://play.jadon.me/chroma/> (big screen: `?tv`).

## How it plays

- Each match is 4, 6 or 8 colours with a 30, 45 or 60 second hunt each. Colours
  get harder as you go: tier 1 is everyday stuff (Ketchup, Blue Jeans,
  Houseplant), tier 4 is muted in-between shades (Mauve, Sage, Petrol).
- Score per colour: up to 1,000 for the colour match plus up to 300 for speed
  (scaled by match², so a fast wrong snap earns almost nothing). Run out of time
  and the phone snaps whatever's in the scope for half points.
- Longer matches have a **memory round**: the colour shows during the countdown,
  then the meter and the target ring go blank. The last colour counts double.
- No screens: the reveal shows everyone's photo, so pointing at someone's phone
  gets you laughed at.

## Colour maths

`public/js/color.js` is shared by the phones and the server: sRGB → linear →
XYZ (D65) → CIELAB, then CIEDE2000 with lightness at half weight (the 2:1:1
"acceptability" variant), because a phone camera guesses exposure. Match is
`exp(-(ΔE/16)²)`: ΔE 4 ≈ 94%, 8 ≈ 78%, 12 ≈ 57%. The implementation passes all
34 reference pairs from Sharma, Wu & Dalal (2005) (`npm test`).

The scope reads a disc of the frame: it starts from the pixels right under the
crosshair, then averages (in linear light) the 60% of the disc most like them,
twice, so edges, glare and shadows at the rim don't drag the colour away.

## Photos

A phone only sends a thumbnail (a ~240 px JPEG of the area around the scope)
when someone else will see it: another player or a big screen. The server keeps
thumbnails in memory, sends them out once in that round's reveal, and deletes
them when the reveal ends. Nothing is written to disk. Solo, the photo never
leaves the phone. The end-of-game palette card is drawn on the phone from its
own photos.

## Run

```
npm install
npm start            # http://localhost:3130
npm test             # colour maths + headless bot matches against the server
```

On a desktop, `?dev` replaces the camera with a painted room you pan with the
arrow keys / WASD or by dragging; Space snaps. `?dev&auto` adds an autopilot
(`&skill=0–1`, `&name=`, `&solo`, `&daily`, `&slot=N` to keep iframes apart).
Locally, `/__test/party.html` runs a big screen plus autopiloted phones in one
tab. `window.__ch` / `window.__tv` are debug handles in dev mode.

Cameras need HTTPS on a real phone. Browsers that won't open the camera in the
page (some in-app browsers) can use the phone's camera app instead.

## Deploy

Container `chroma` on port 3130 behind Caddy at `/chroma/`, like the other
play.jadon.me games (see `../play/DEPLOY.md`).
