// The body map.
//
// Every region is authored once for the LEFT half of the figure and mirrored
// across the centre line, so the figure cannot drift out of symmetry when a
// shape gets tweaked. `mirror: false` means the shape is already centred and
// is drawn a single time.
//
// viewBox is 0 0 220 470, centre line at x = 110.
//
//   group   the muscle id in muscles.js — this is what makes it tappable.
//           Regions with no group are inert scenery (head, hands, joints).

export const VIEW = { w: 220, h: 470, cx: 110 };

const HEAD = { d: 'M110,11 C97,11 89,22 89,36 C89,50 97,60 110,60 C123,60 131,50 131,36 C131,22 123,11 110,11 Z', mirror: false };
const NECK = { d: 'M99,53 L121,53 L124,77 L96,77 Z', mirror: false };
const HAND = { d: 'M36,240 C30,244 27,255 31,263 C35,269 43,268 46,261 C49,251 45,242 40,239 Z' };
const KNEE = { d: 'M84,307 C79,314 79,326 83,333 C92,338 101,336 104,329 C106,318 103,310 100,306 Z' };
const FOOT = { d: 'M89,405 C84,411 82,421 86,427 L106,427 C108,419 106,410 103,404 Z' };
const PELVIS = { d: 'M86,185 C81,195 80,206 84,217 C96,223 110,224 110,224 L110,183 Z' };
const UPPER_ARM_SHELL = { d: 'M65,111 C56,112 50,124 48,138 C46,151 48,163 52,170 C59,170 64,162 66,150 C68,136 68,120 65,111 Z' };
const FOREARM_SHELL = { d: 'M53,169 C46,174 41,187 38,203 C35,218 34,231 36,240 C43,242 48,235 50,224 C54,207 56,187 53,169 Z' };
const CALF_SHELL = { d: 'M101,329 C92,330 85,338 84,352 C83,371 86,390 90,404 C96,410 101,407 103,398 C105,376 104,348 101,329 Z' };

// ---------------------------------------------------------------- front view

export const FRONT = [
  { ...HEAD, id: 'head' },
  { ...NECK, id: 'neck' },
  { ...PELVIS, id: 'pelvis' },

  { group: 'traps', d: 'M99,56 C89,61 79,69 71,82 C79,89 90,90 98,85 C99,74 99,64 99,56 Z' },
  { group: 'shoulders', d: 'M72,79 C60,83 52,94 51,108 C51,119 57,127 66,128 C73,124 77,113 78,100 C78,90 76,84 72,79 Z' },
  { group: 'chest', d: 'M107,74 C93,75 81,81 75,91 C73,102 75,117 81,125 C92,130 102,128 108,121 C109,106 109,87 107,74 Z' },
  { group: 'biceps', ...UPPER_ARM_SHELL },
  { group: 'forearms', ...FOREARM_SHELL },
  { ...HAND, id: 'hand' },

  { group: 'abs', d: 'M107,123 C98,123 90,128 89,138 C88,154 89,172 92,184 C97,191 104,192 107,188 Z' },
  { group: 'obliques', d: 'M87,125 C80,129 76,140 76,153 C76,169 80,183 88,192 C90,186 89,168 88,152 C88,140 87,132 87,125 Z' },

  { group: 'abductors', d: 'M85,189 C77,195 72,206 71,220 C71,231 75,239 80,242 C84,234 86,220 87,205 Z' },
  { group: 'quads', d: 'M102,211 C90,212 80,220 77,234 C74,253 76,278 82,300 C88,312 98,314 103,306 C105,280 105,239 102,211 Z' },
  { group: 'adductors', d: 'M108,213 C102,217 99,228 98,244 C97,260 100,275 105,287 C108,282 109,256 109,235 Z' },
  { ...KNEE, id: 'knee' },
  { group: 'calves', ...CALF_SHELL },
  { ...FOOT, id: 'foot' },
];

// Non-interactive line work — collarbones, sternum, ab segmentation, shins.
export const FRONT_DETAIL = [
  'M110,124 L110,188',
  'M92,140 L128,140', 'M91,157 L129,157', 'M93,173 L127,173',
  'M99,79 L110,84 L121,79',
  'M110,214 L110,222',
];

// ----------------------------------------------------------------- back view

export const BACK = [
  { ...HEAD, id: 'head' },
  { ...NECK, id: 'neck' },
  { ...PELVIS, id: 'pelvis' },

  // Drawn outermost-first so the shapes tile: the trapezius fans from the neck
  // down to the spine, the lat wing sits under it, and the rhomboids sit on top
  // of the lat's inner edge — which is how they stack anatomically.
  { group: 'traps', d: 'M104,56 C91,61 79,69 71,82 C76,92 86,102 96,110 C101,114 105,118 108,122 C109,110 109,86 108,72 C107,62 106,58 104,56 Z' },
  { group: 'shoulders', d: 'M72,79 C60,83 52,94 51,108 C51,119 57,127 66,128 C73,124 77,113 78,100 C78,90 76,84 72,79 Z' },
  { group: 'lats', d: 'M76,91 C69,103 68,124 72,144 C77,162 86,174 97,181 C104,181 108,176 108,167 C105,150 100,130 95,115 C90,102 84,93 76,91 Z' },
  { group: 'upper-back', d: 'M96,109 C88,113 83,122 82,133 C82,143 86,152 92,158 C99,159 105,155 107,148 C107,134 103,119 96,109 Z' },
  { group: 'triceps', ...UPPER_ARM_SHELL },
  { group: 'forearms', ...FOREARM_SHELL },
  { ...HAND, id: 'hand' },

  { group: 'lower-back', d: 'M95,151 C89,156 86,166 86,178 C86,189 90,197 96,202 C103,202 108,196 109,187 C108,172 103,158 95,151 Z' },
  { group: 'glutes', d: 'M106,190 C93,190 82,196 78,208 C75,221 77,235 84,244 C93,250 104,248 108,240 C110,224 109,205 106,190 Z' },
  { group: 'hamstrings', d: 'M104,246 C92,247 82,254 79,268 C76,284 78,298 84,309 C91,316 100,315 104,307 C106,288 106,265 104,246 Z' },
  { ...KNEE, id: 'knee' },
  { group: 'calves', ...CALF_SHELL },
  { ...FOOT, id: 'foot' },
];

export const BACK_DETAIL = [
  'M110,78 L110,200',
  'M110,250 L110,258',
];
