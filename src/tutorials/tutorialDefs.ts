/**
 * The fifteen lessons of the Tutorials tab — a LEAF: this module imports
 * nothing but types (`bootWave.test.ts` holds it to that), so the asset
 * browser can import it statically. Everything executable lives in
 * `tutorialRun.ts` / `tutorialAutoStep.ts`.
 *
 * Thirteen lessons build the thirteen beginner recipes of the Presets tab by
 * hand (`recipeId`) — Presets shows the finished thing, this tab builds it —
 * plus two concepts the recipes do not cover (Circle: distance fields; Shiny or
 * Dull: the material dials). The order follows the surveyed curricula (Book of
 * Shaders, Catlike Coding, Unity Learn, Unreal's Content Examples, Godot):
 * colour → coordinates → repetition → shapes → time → noise → blending →
 * cells → directions → material dials → view → transparency → clipping →
 * vertices → animated vertices. Three authoring rules from the same research:
 * show the RAW field (a grey) before mapping it through Color Ramp; interleave
 * adds and wires so the 3D preview changes every step or two; every lesson
 * opens with the idea and closes with one "Try: …" change and a question.
 *
 * Captions are English and printable ASCII, at most MAX_CAPTION_CHARS; every
 * one is a key in lv.json `ui` (`tutorialI18n.test.ts`). A node is named the
 * way its tile is ("Perlin Noise", "Color Ramp"); a socket the way its label
 * reads. Hex values are LOWERCASE: the colour node emits them verbatim and the
 * recipe parse stores them lowercase, which is what keeps `byteExact` honest.
 */

import type { TutorialDef, TutorialStep } from './tutorialTypes';

const look = (id: string, caption: string): TutorialStep => ({ id, kind: 'look', caption });
const add = (id: string, role: string, type: string, caption: string, hint?: string, values?: Readonly<Record<string, number | string>>): TutorialStep =>
  ({ id, kind: 'add', role, type, caption, ...(hint ? { hint } : {}), ...(values ? { values } : {}) });
const wire = (id: string, from: readonly [string, string], to: readonly [string, string], caption: string, hint?: string): TutorialStep =>
  ({ id, kind: 'wire', from, to, caption, ...(hint ? { hint } : {}) });
const set = (id: string, role: string, key: string, value: number | string, caption: string, hint?: string): TutorialStep =>
  ({ id, kind: 'set', role, key, value, caption, ...(hint ? { hint } : {}) });
const expose = (id: string, handle: string, caption: string, hint?: string): TutorialStep =>
  ({ id, kind: 'expose', role: 'out', handle, caption, ...(hint ? { hint } : {}) });

const HINT_COLOR = 'Palette > Types > Color, or right-click the canvas and type color';
const HINT_UV = 'Palette > Inputs > UV, or right-click the canvas and type uv';
const HINT_SPLIT = 'Palette > Vector > Split, or right-click the canvas and type split';
const HINT_RAMP = 'Palette > Types > Color Ramp, or right-click the canvas and type ramp';
const HINT_PERLIN = 'Palette > Noise > Perlin Noise, or right-click the canvas and type perlin';
const HINT_SCALE = 'Right-click the node > Scale';
const HINT_INTERP = 'Right-click the node > Interpolation';
const HINT_OUTPUT_MENU = 'Right-click the Output node';
const HINT_FRESNEL = 'Palette > Inputs > Fresnel, or right-click the canvas and type fresnel';
const HINT_TIME = 'Palette > Inputs > Time, or right-click the canvas and type time';

export const TUTORIALS: readonly TutorialDef[] = [
  {
    id: 'tut-solid',
    title: 'One Color',
    summary: 'The smallest shader there is: one Color node into the Output. What a material is, and what the Output node does.',
    recipeId: 'recipe-solid',
    recipeName: 'Solid Color',
    byteExact: true,
    steps: [
      look('idea', 'A shader answers one question for every pixel of the model at once: what colour is this pixel? The Output node is where that answer goes.'),
      add('paint', 'paint', 'color', 'Add a Color node. A colour is three numbers - red, green and blue - each from 0 to 1.', HINT_COLOR, { hex: '#4fc3f7' }),
      wire('w1', ['paint', 'out'], ['out', 'color'], 'Wire the Color into the Output\'s Color socket. The whole model turns that colour: every pixel got the same answer.'),
      look('try', 'Try: double-click the Color node and pick another colour. Blender, Unity and Unreal all call this socket Base Color.'),
    ],
  },
  {
    id: 'tut-gradient',
    title: 'Where Am I?',
    summary: 'UV coordinates: every pixel knows where it is. A number shown as grey, then a Color Ramp to turn numbers into colours.',
    recipeId: 'recipe-gradient',
    recipeName: 'Gradient',
    steps: [
      look('idea', 'Every pixel knows where it is on the surface: its UV, two numbers from 0 to 1. A gradient is just that coordinate shown as brightness.'),
      add('uv', 'coord', 'uv', 'Add a UV node. It outputs the pixel\'s position on the texture: U runs left to right, V bottom to top, both from 0 to 1.', HINT_UV),
      add('split', 'axes', 'split', 'Add a Split node. It takes a vector apart into its single numbers: X, Y, Z and W.', HINT_SPLIT),
      wire('w1', ['coord', 'out'], ['axes', 'v'], 'Wire UV into Split\'s Vector input. Now X is the U coordinate and Y is the V coordinate.'),
      wire('w2', ['axes', 'y'], ['out', 'color'], 'Wire Split\'s Y into the Output Color. One number shown as a colour is grey: 0 is black, 1 is white. This is the raw coordinate.'),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp. It turns a number from 0 to 1 into a colour read off a gradient bar.', HINT_RAMP, { stops: '0 #1565c0 1,1 #ff8a65 1' }),
      wire('w3', ['axes', 'y'], ['ramp', 'fac'], 'Wire Split\'s Y into the ramp\'s Factor. The number now picks a point along the bar instead of a grey.'),
      wire('w4', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp\'s Color into the Output Color. The grey became a two-colour gradient: same numbers, new palette.'),
      look('try', 'Try: wire X instead of Y. Which way does the gradient run? Set the preview Model to Plane to see the UV square flat.'),
    ],
  },
  {
    id: 'tut-stripes',
    title: 'Stripes',
    summary: 'Tiling: Multiply stretches a coordinate, Fract repeats it, and a constant Color Ramp is a hard threshold.',
    recipeId: 'recipe-stripes',
    recipeName: 'Stripes',
    steps: [
      look('idea', 'Patterns repeat because numbers repeat. Multiply stretches a coordinate, Fract folds it back into 0 to 1 again and again.'),
      add('uv', 'coord', 'uv', 'Add a UV node.', HINT_UV),
      add('split', 'axes', 'split', 'Add a Split node.', HINT_SPLIT),
      wire('w1', ['coord', 'out'], ['axes', 'v'], 'Wire UV into Split.'),
      wire('w2', ['axes', 'x'], ['out', 'color'], 'Wire Split\'s X into the Output Color: one grey ramp across the surface, 0 to 1.'),
      set('tile', 'coord', 'tilingU', 8, 'On the UV node set U to 8. The coordinate now runs 0 to 8 across the surface, so the grey hits white almost at once.', 'The U number box on the UV node'),
      add('fract', 'rep', 'fract', 'Add a Fract node. It keeps the part after the decimal point: 3.7 becomes 0.7, so 0 to 8 becomes eight ramps of 0 to 1.', 'Palette > Math > Fract, or right-click the canvas and type fract'),
      wire('w3', ['axes', 'x'], ['rep', 'x'], 'Wire Split\'s X into Fract.'),
      wire('w4', ['rep', 'out'], ['out', 'color'], 'Wire Fract into the Output Color. Eight grey ramps side by side: that is tiling.'),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp.', HINT_RAMP, { stops: '0 #263238 1,0.5 #eceff1 1' }),
      wire('w5', ['rep', 'out'], ['ramp', 'fac'], 'Wire Fract into the ramp\'s Factor.'),
      wire('w6', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp into the Output Color: eight soft ramps between two colours.'),
      set('hard', 'ramp', 'interp', 'constant', 'Right-click the Color Ramp and set Interpolation to Constant. No blending: a hard threshold at 0.5 turns soft ramps into crisp stripes.', HINT_INTERP),
      look('try', 'Try: set U back to 1 and the stripes vanish - Fract on a 0 to 1 number changes nothing. Scale first, then repeat.'),
    ],
  },
  {
    id: 'tut-circle',
    title: 'Circle',
    summary: 'Shapes from distance: measure how far each pixel is from a centre, then threshold it with Smoothstep. The first distance field.',
    steps: [
      look('idea', 'A shape is a question about distance. Measure how far each pixel is from a centre, then decide: inside or outside.'),
      add('uv', 'coord', 'uv', 'Add a UV node.', HINT_UV),
      add('sub', 'centred', 'sub', 'Add a Subtract node. Taking 0.5 off both UV axes moves the centre of the square to 0,0.', 'Palette > Arithmetic > Subtract, or right-click the canvas and type sub'),
      wire('w1', ['coord', 'out'], ['centred', 'a'], 'Wire UV into Subtract\'s A.'),
      set('half', 'centred', 'b', 0.5, 'Set B on Subtract to 0.5. A vector minus one number takes it off every component.', 'The B number box on the Subtract node'),
      add('len', 'dist', 'length', 'Add a Length node. It measures how far a vector reaches from 0,0: here, the pixel\'s distance from the centre.', 'Palette > Vector > Length, or right-click the canvas and type length'),
      wire('w2', ['centred', 'out'], ['dist', 'v'], 'Wire Subtract into Length.'),
      wire('w3', ['dist', 'out'], ['out', 'color'], 'Wire Length into the Output Color. Dark at the centre, brighter outward: a distance field, 0 in the middle.'),
      add('smooth', 'edge', 'smoothstep', 'Add a Smoothstep node. Below Edge 0 it gives 0, above Edge 1 it gives 1, with a soft blend between the two.', 'Palette > Interpolation > Smoothstep, or right-click the canvas and type smooth'),
      wire('w4', ['dist', 'out'], ['edge', 'x'], 'Wire Length into Smoothstep\'s X.'),
      set('e0', 'edge', 'edge0', 0.3, 'Set Edge 0 to 0.3. Everything closer than 0.3 to the centre becomes 0: black.', 'The Edge 0 number box on the Smoothstep node'),
      set('e1', 'edge', 'edge1', 0.32, 'Set Edge 1 to 0.32. The two edges are the disc\'s border, 0.02 wide: crisp but not jagged.', 'The Edge 1 number box on the Smoothstep node'),
      wire('w5', ['edge', 'out'], ['out', 'color'], 'Wire Smoothstep into the Output Color: a black disc on white. Distance plus a threshold is how every shape starts.'),
      look('try', 'Try: swap the edges (0.32 and 0.3) to invert the disc, or set Model to Plane to see it flat. Why is it stretched on the sphere?'),
    ],
  },
  {
    id: 'tut-pulse',
    title: 'Pulse',
    summary: 'Time as an input: Sine turns it into a wave from -1 to 1, Remap moves that onto 0 to 1, a Color Ramp paints it.',
    recipeId: 'recipe-pulse',
    recipeName: 'Pulse',
    byteExact: true,
    steps: [
      look('idea', 'Time is just another number flowing into the graph; it grows every frame. Anything computed from it moves.'),
      add('time', 'clock', 'time', 'Add a Time node. Its output counts the seconds since the shader started.', HINT_TIME),
      add('sin', 'wave', 'sin', 'Add a Sine node. Sine turns a growing number into a wave that swings between -1 and 1.', 'Palette > Math > Sine, or right-click the canvas and type sin'),
      wire('w1', ['clock', 'out'], ['wave', 'x'], 'Wire Time into Sine.'),
      wire('w2', ['wave', 'out'], ['out', 'color'], 'Wire Sine into the Output Color. It flashes, but half of the time it is below 0, and a negative colour is just black.'),
      add('remap', 'range', 'remap', 'Add a Remap node. It maps one range onto another: here -1..1 onto 0..1.', 'Palette > Interpolation > Remap, or right-click the canvas and type remap'),
      wire('w3', ['wave', 'out'], ['range', 'x'], 'Wire Sine into Remap\'s Value.'),
      set('lo', 'range', 'inLow', -1, 'Set In Low to -1. In Low and In High describe the range coming in; Out Low and Out High the range going out.', 'The In Low number box on the Remap node'),
      wire('w4', ['range', 'out'], ['out', 'color'], 'Wire Remap into the Output Color. The pulse now breathes between black and white with no dead half.'),
      set('speed', 'clock', 'speed', 2, 'Set the Time node\'s Speed to 2. Time itself has no knob; multiplying it is how every editor changes tempo.', 'The Speed number box on the Time node, or right-click it > Speed'),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp.', HINT_RAMP, { stops: '0 #311b92 1,1 #ffea00 1' }),
      wire('w5', ['range', 'out'], ['ramp', 'fac'], 'Wire Remap into the ramp\'s Factor.'),
      wire('w6', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp into the Output Color: a pulse between two colours.'),
      look('try', 'Try: wire Sine straight into the ramp\'s Factor. Why does the colour stick at one end half of the time? (The ramp clamps below 0.)'),
    ],
  },
  {
    id: 'tut-noise',
    title: 'Noise',
    summary: 'Noise: a smooth random number for every point, the base of clouds, marble and terrain. Scale, the 0 to 1 range, and a ramp over it.',
    recipeId: 'recipe-noise',
    recipeName: 'Noise Patches',
    byteExact: true,
    steps: [
      look('idea', 'Noise is a smooth random number for every point in space: no two spots alike, no sharp jumps. Clouds, marble, wood and terrain start here.'),
      add('perlin', 'noise', 'perlin', 'Add a Perlin Noise node. A new one outputs 0 to 1. Older graphs here, and MaterialX, are signed -1 to 1; Blender centres on 0.5.', HINT_PERLIN),
      wire('w1', ['noise', 'out'], ['out', 'color'], 'Wire the noise into the Output Color: grey clouds. This is the raw field. Look at it before colouring it.'),
      set('scale', 'noise', 'scale', 3, 'Right-click Perlin Noise and set Scale to 3. Scale multiplies the position the noise reads, so a bigger scale means smaller blobs.', HINT_SCALE),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp. Its two stops sit at 0.4 and 0.6, so just the middle of the noise range spans the whole gradient.', HINT_RAMP, { stops: '0.4 #1b5e20 1,0.6 #fff9c4 1' }),
      wire('w2', ['noise', 'out'], ['ramp', 'fac'], 'Wire the noise into the ramp\'s Factor.'),
      wire('w3', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp into the Output Color: green and cream patches with soft borders.'),
      look('try', 'Try: wire the noise into Roughness as well. One field can drive any channel. Why do the shiny spots follow the cream ones?'),
    ],
  },
  {
    id: 'tut-mix',
    title: 'Mix Two Colors',
    summary: 'Blend two colours with a Mix node, and let noise decide where each one shows.',
    recipeId: 'recipe-mix',
    recipeName: 'Mix Two Colors',
    steps: [
      look('idea', 'Mix blends A and B by its Factor: 0 shows A, 1 shows B, 0.5 half of each. We will build the Factor from noise.'),
      add('perlin', 'noise', 'perlin', 'Add a Perlin Noise node. A new Perlin gives a smooth value from 0 to 1 at every point.', HINT_PERLIN),
      wire('w0', ['noise', 'out'], ['out', 'color'], 'Wire the noise into the Output Color socket. A single number shown as colour is grey: 0 black, 1 white.'),
      set('scale', 'noise', 'scale', 3, 'Right-click Perlin Noise and set Scale to 3. Scale multiplies the position: bigger means smaller patches.', HINT_SCALE),
      add('round', 'pick', 'round', 'Add a Round node. It snaps every value to the nearest whole number - here to exactly 0 or 1.', 'Palette > Math > Round, or right-click the canvas and type round'),
      wire('w1', ['noise', 'out'], ['pick', 'x'], 'Wire Perlin Noise into Round: drag from the noise output onto the X socket, or drop the node onto Round.'),
      wire('w2', ['pick', 'out'], ['out', 'color'], 'Wire Round into the Output Color. The soft clouds become hard black and white patches: a mask.'),
      add('mix', 'blend', 'mix', 'Add a Mix node. Three inputs: A, B and the Factor that picks between them.', 'Palette > Interpolation > Mix, or right-click the canvas and type mix'),
      wire('w3', ['pick', 'out'], ['blend', 't'], 'Wire Round into Mix\'s Factor. Where it is 0 Mix shows A, where it is 1 it shows B.'),
      wire('w4', ['blend', 'out'], ['out', 'color'], 'Wire Mix into the Output Color. A and B are still plain numbers, so the patches stay black and white.'),
      add('colorA', 'colorA', 'color', 'Add a Color node for side A - pick any colour you like.', HINT_COLOR, { hex: '#4a148c' }),
      wire('w5', ['colorA', 'out'], ['blend', 'a'], 'Wire it into Mix\'s A. Every spot where the Factor is 0 takes this colour.'),
      add('colorB', 'colorB', 'color', 'Add a second Color node for side B.', HINT_COLOR, { hex: '#ffc107' }),
      wire('w6', ['colorB', 'out'], ['blend', 'b'], 'Wire it into Mix\'s B. Now every spot is pure A or pure B.'),
      look('try', 'Try: delete Round. The wire heals itself and the blend turns soft. Why does a Factor between 0 and 1 blend the colours?'),
    ],
  },
  {
    id: 'tut-cells',
    title: 'Cells',
    summary: 'Cell Noise: one random value per cell and nothing in between. A constant Color Ramp as a lookup table.',
    recipeId: 'recipe-tiles',
    recipeName: 'Random Tiles',
    byteExact: true,
    steps: [
      look('idea', 'Perlin is smooth. Cell Noise is the opposite: one random number per whole cell and nothing in between, so it costs almost nothing.'),
      add('cells', 'cells', 'cellNoise', 'Add a Cell Noise node.', 'Palette > Noise > Cell Noise, or right-click the canvas and type cell'),
      wire('w1', ['cells', 'out'], ['out', 'color'], 'Wire it into the Output Color: a grey mosaic. Every cell is one flat value.'),
      set('scale', 'cells', 'scale', 4, 'Right-click Cell Noise and set Scale to 4: four cells per unit instead of one.', HINT_SCALE),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp. This one has four stops; with Constant interpolation a ramp is a lookup table: one colour per quarter.', HINT_RAMP, { stops: '0 #0b3c5d 1,0.25 #328cc1 1,0.5 #f2c14e 1,0.75 #d9483b 1' }),
      wire('w2', ['cells', 'out'], ['ramp', 'fac'], 'Wire Cell Noise into the ramp\'s Factor.'),
      wire('w3', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp into the Output Color.'),
      set('hard', 'ramp', 'interp', 'constant', 'Right-click the Color Ramp and set Interpolation to Constant. Now each cell takes exactly one of the four colours.', HINT_INTERP),
      look('try', 'Try: set the interpolation back to Linear. Why do cells now show colours that are in none of the four stops?'),
    ],
  },
  {
    id: 'tut-snow',
    title: 'Up Is Snow',
    summary: 'Normals: the direction a surface faces, stored as numbers. Its Y says how much a point faces up, and a ramp draws the snow line.',
    recipeId: 'recipe-snow',
    recipeName: 'Snow on Top',
    byteExact: true,
    steps: [
      look('idea', 'A normal is the direction a surface faces, stored as three numbers. Straight up is Y = 1, straight down Y = -1. Directions are data too.'),
      add('nrm', 'nrm', 'normalWorld', 'Add a Normal (world) node. World space means the direction stays put while the model turns.', 'Palette > Inputs > Normal (world), or right-click the canvas and type normal'),
      wire('w1', ['nrm', 'out'], ['out', 'color'], 'Wire it into the Output Color. The classic rainbow sphere: X, Y and Z shown as red, green and blue.'),
      add('split', 'axes', 'split', 'Add a Split node.', HINT_SPLIT),
      wire('w2', ['nrm', 'out'], ['axes', 'v'], 'Wire the normal into Split.'),
      wire('w3', ['axes', 'y'], ['out', 'color'], 'Wire Y into the Output Color: white on top, black underneath. That number is "how much does this point face up".'),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp. Its stops at 0.35 and 0.55 draw the snow line.', HINT_RAMP, { stops: '0.35 #5d4037 1,0.55 #fafafa 1' }),
      wire('w4', ['axes', 'y'], ['ramp', 'fac'], 'Wire Y into the ramp\'s Factor.'),
      wire('w5', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp into the Output Color: snow on top, earth below.'),
      look('try', 'Try: replace Normal (world) with Normal. Spin the preview: why does the snow now turn with the model?'),
    ],
  },
  {
    id: 'tut-material',
    title: 'Shiny or Dull',
    summary: 'Colour is one channel of a material. Roughness and Metalness are two more: 0 to 1 dials every physically based renderer understands.',
    steps: [
      look('idea', 'Colour is one channel of a material. Roughness and Metalness are two more: 0 to 1 dials that every physically based renderer understands.'),
      add('paint', 'paint', 'color', 'Add a Color node.', HINT_COLOR, { hex: '#b0bec5' }),
      wire('w1', ['paint', 'out'], ['out', 'color'], 'Wire it into the Output Color.'),
      set('rough', 'out', 'roughness', 0.1, 'On the Output node set Roughness to 0.1. Roughness 1 is chalk, 0 is a mirror: the highlight sharpens.', 'The number box beside the Output\'s Roughness socket'),
      expose('metal', 'metalness', 'Right-click the Output and tick Metalness. Channels you do not use stay hidden; ticking one gives it a socket and a number.', HINT_OUTPUT_MENU),
      set('metal1', 'out', 'metalness', 1, 'Set Metalness to 1. Metal reflects in its own colour and loses its diffuse shading; most things are metal or not, 0 or 1.', 'The number box beside the Output\'s Metalness socket'),
      look('try', 'Try: wire a Perlin Noise into Roughness. One field can drive any channel: smudges on a chrome ball.'),
    ],
  },
  {
    id: 'tut-rim',
    title: 'Rim Light',
    summary: 'View-dependent shading: Fresnel compares the surface direction with the view. A glowing rim through the Emissive channel.',
    recipeId: 'recipe-edge',
    recipeName: 'Glowing Edge',
    byteExact: true,
    steps: [
      look('idea', 'Some effects depend on where you look from. Fresnel compares the surface direction with the view direction: edges face away, the middle faces you.'),
      add('fres', 'fres', 'fresnel', 'Add a Fresnel node. Its Facing output is 0 where the surface faces you and 1 at the silhouette.', HINT_FRESNEL),
      wire('w1', ['fres', 'facing'], ['out', 'color'], 'Wire Facing into the Output Color: a dark centre and a bright rim that follows the camera as you orbit.'),
      add('ramp', 'ramp', 'colorRamp', 'Add a Color Ramp.', HINT_RAMP, { stops: '0.4 #000000 1,1 #00e5ff 1' }),
      wire('w2', ['fres', 'facing'], ['ramp', 'fac'], 'Wire Facing into the ramp\'s Factor.'),
      wire('w3', ['ramp', 'out'], ['out', 'color'], 'Wire the ramp into the Output Color. Black until 0.4, then cyan: only the rim is lit.'),
      expose('glow', 'emissive', 'Right-click the Output and tick Emissive. Emissive is light the surface gives off itself, untouched by the scene\'s lights.', HINT_OUTPUT_MENU),
      wire('w4', ['ramp', 'out'], ['out', 'emissive'], 'Wire the ramp into Emissive too. The rim now glows on the shadow side as well: a hologram outline.'),
      look('try', 'Try: use the Fresnel output instead of Facing. It is the physically based curve: mirror-like at grazing angles, as water and glass are.'),
    ],
  },
  {
    id: 'tut-ghost',
    title: 'Ghost',
    summary: 'Opacity: a 0 to 1 number per pixel, and why a material ignores it until Transparent is on. Fresnel makes the middle fade.',
    recipeId: 'recipe-ghost',
    recipeName: 'Ghost',
    byteExact: true,
    steps: [
      look('idea', 'Opacity is a number from 0 to 1 per pixel: 0 is invisible, 1 solid. But a material ignores it until you say it is transparent.'),
      add('body', 'body', 'color', 'Add a Color node.', HINT_COLOR, { hex: '#80deea' }),
      wire('w1', ['body', 'out'], ['out', 'color'], 'Wire it into the Output Color.'),
      add('fres', 'fres', 'fresnel', 'Add a Fresnel node.', HINT_FRESNEL),
      expose('clear', 'opacity', 'Right-click the Output and tick Transparent. That turns on blending AND reveals the Opacity socket: two things every engine couples.', HINT_OUTPUT_MENU),
      wire('w2', ['fres', 'facing'], ['out', 'opacity'], 'Wire Facing into Opacity. The middle (Facing 0) goes clear, the rim (1) stays solid: a ghost.'),
      look('try', 'Try: wire Fresnel instead of Facing, or untick Transparent and watch the wire do nothing. Where else could a 0 to 1 mask go?'),
    ],
  },
  {
    id: 'tut-holes',
    title: 'Holes',
    summary: 'Masks and Discard: Greater Than turns noise into 0 or 1, and Discard deletes the pixels where it is 1. The dissolve effect.',
    recipeId: 'recipe-holes',
    recipeName: 'Holes',
    steps: [
      look('idea', 'A mask is a number that is 0 or 1. Discard uses one to delete pixels outright: the dissolve effect every engine has.'),
      add('perlin', 'noise', 'perlin', 'Add a Perlin Noise node.', HINT_PERLIN, { scale: 4 }),
      add('gt', 'cut', 'greaterThan', 'Add a Greater Than node. It outputs 1 where A is greater than B, else 0: a threshold that makes a mask.', 'Palette > Logic > Greater Than, or right-click the canvas and type greater'),
      wire('w1', ['noise', 'out'], ['cut', 'a'], 'Wire the noise into A.'),
      set('cutoff', 'cut', 'b', 0.6, 'Set B to 0.6. Everywhere the noise is above 0.6 becomes 1, the rest 0.', 'The B number box on the Greater Than node'),
      wire('w2', ['cut', 'out'], ['out', 'color'], 'Wire Greater Than into the Output Color to see the mask: white spots on black.'),
      expose('cut', 'discard', 'Right-click the Output and tick Discard. Discard is a yes/no per pixel, not a colour.', HINT_OUTPUT_MENU),
      wire('w3', ['cut', 'out'], ['out', 'discard'], 'Wire Greater Than into Discard. Every pixel where the mask is 1 is thrown away: holes right through the model.'),
      add('paint', 'paint', 'color', 'Add a Color node.', HINT_COLOR, { hex: '#ffb74d' }),
      wire('w4', ['paint', 'out'], ['out', 'color'], 'Wire the Color into the Output Color, so what is left of the surface has a colour again.'),
      look('try', 'Try: scrub B from 0.6 toward 0 and the model dissolves. That is the dissolve slider. What would Less Than do?'),
    ],
  },
  {
    id: 'tut-bumps',
    title: 'Bumps',
    summary: 'Displacement: the same number that coloured a pixel can move a point of the mesh. The vertex side of a shader.',
    recipeId: 'recipe-bumps',
    recipeName: 'Bumps',
    byteExact: true,
    steps: [
      look('idea', 'So far every number coloured a pixel. The same number can also MOVE a point of the mesh: that is the vertex side of a shader.'),
      add('perlin', 'noise', 'perlin', 'Add a Perlin Noise node.', HINT_PERLIN),
      set('scale', 'noise', 'scale', 2, 'Right-click Perlin Noise and set Scale to 2.', HINT_SCALE),
      wire('w1', ['noise', 'out'], ['out', 'position'], 'Wire the noise into Displacement. Each point moves out along its normal by the noise amount, 0 to 1 model units: huge.'),
      add('mul', 'amount', 'mul', 'Add a Multiply node. Multiplying by a small number scales the push down.', 'Palette > Arithmetic > Multiply, or right-click the canvas and type mul'),
      wire('w2', ['noise', 'out'], ['amount', 'a'], 'Wire the noise into A.'),
      set('k', 'amount', 'b', 0.2, 'Set B to 0.2. The lumps are now at most 0.2 units high.', 'The B number box on the Multiply node'),
      wire('w3', ['amount', 'out'], ['out', 'position'], 'Wire Multiply into Displacement: soft bumps. Blender calls this Displacement, Unreal World Position Offset.'),
      look('try', 'Try: wire the noise into Color as well, so colour follows height. Why does the silhouette change while the shading looks flat?'),
    ],
  },
  {
    id: 'tut-wobble',
    title: 'Wobble',
    summary: 'Animating a pattern: add Time to the coordinates the noise reads and the bumps keep re-forming. Scrolling UVs, panning.',
    recipeId: 'recipe-wobble',
    recipeName: 'Wobble',
    byteExact: true,
    steps: [
      look('idea', 'A pattern moves when the coordinates it reads move. Add Time to the position and the noise slides through the mesh.'),
      add('pos', 'pos', 'positionGeometry', 'Add a Position node: each point\'s own location in the model, three numbers.', 'Palette > Inputs > Position, or right-click the canvas and type position'),
      add('time', 'clock', 'time', 'Add a Time node.', HINT_TIME),
      add('add', 'moved', 'add', 'Add an Add node.', 'Palette > Arithmetic > Add, or right-click the canvas and type add'),
      wire('w1', ['pos', 'out'], ['moved', 'a'], 'Wire Position into A.'),
      wire('w2', ['clock', 'out'], ['moved', 'b'], 'Wire Time into B. A number added to a vector shifts all three axes, so the whole field drifts diagonally.'),
      add('perlin', 'noise', 'perlin', 'Add a Perlin Noise node.', HINT_PERLIN, { scale: 2 }),
      wire('w3', ['moved', 'out'], ['noise', 'pos'], 'Wire Add into the noise\'s Pos input: drag the wire onto the node and its hidden Pos socket appears. The noise reads the moving coordinate.', 'Hidden inputs show while a wire is dragged near a node; or right-click it and tick Pos'),
      wire('w4', ['noise', 'out'], ['out', 'position'], 'Wire the noise into Displacement. The surface heaves by up to a full unit, and keeps moving.'),
      add('mul', 'amount', 'mul', 'Add a Multiply node.', 'Palette > Arithmetic > Multiply, or right-click the canvas and type mul'),
      wire('w5', ['noise', 'out'], ['amount', 'a'], 'Wire the noise into A.'),
      set('k', 'amount', 'b', 0.2, 'Set B to 0.2.', 'The B number box on the Multiply node'),
      wire('w6', ['amount', 'out'], ['out', 'position'], 'Wire Multiply into Displacement. The bumps now re-form continuously: a living surface. Unity scrolls UVs the same way; Unreal calls it a Panner.'),
      look('try', 'Try: put a Multiply between Time and Add to change the drift speed, or wire the noise into Color too. What else could you add Time to?'),
    ],
  },
];

/** The lesson with this id, or undefined. */
export function findTutorial(id: string): TutorialDef | undefined {
  return TUTORIALS.find((d) => d.id === id);
}
