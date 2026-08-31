import { MUSCLES, FRONT_GROUPS, BACK_GROUPS } from './muscles.js';
import { VIEW, FRONT, FRONT_DETAIL, BACK, BACK_DETAIL } from './body.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let drawOrder = [];  // region paths in the order body.js declares them

const state = {
  view: 'front',   // front | back
  selected: null,  // first tap: highlighted, not yet opened
  open: null,      // second tap: the group whose sheet is showing
};

const el = {
  stage: document.querySelector('.stage'),
  prompt: document.querySelector('.prompt'),
  toggle: document.querySelectorAll('.viewtoggle button'),
  scrim: document.querySelector('.scrim'),
  sheet: document.querySelector('.sheet'),
  sheetHead: document.querySelector('.sheet-head'),
  sheetBody: document.querySelector('.sheet-body'),
  browse: document.querySelector('.browse'),
};

// --------------------------------------------------------------- rendering

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// A region is authored for the left half only; unless it is already centred we
// draw it twice, the second time flipped about the centre line.
function addRegion(parent, region) {
  const copies = region.mirror === false
    ? [null]
    : [null, `translate(${VIEW.w},0) scale(-1,1)`];

  for (const transform of copies) {
    const attrs = { d: region.d, class: region.group ? 'region muscle' : 'region scenery' };
    if (transform) attrs.transform = transform;

    if (region.group) {
      const muscle = MUSCLES[region.group];
      attrs['data-group'] = region.group;
      attrs.tabindex = '0';
      attrs.role = 'button';
      attrs['aria-label'] = muscle.name;
    }
    parent.appendChild(svgEl('path', attrs));
  }
}

function drawFigure() {
  const [regions, detail] = state.view === 'front'
    ? [FRONT, FRONT_DETAIL]
    : [BACK, BACK_DETAIL];

  const svg = svgEl('svg', {
    class: 'figure',
    viewBox: `0 0 ${VIEW.w} ${VIEW.h}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
    'aria-label': `${state.view} view of the body — tap a muscle`,
  });

  // Two groups: the line work always sits above the muscles, and reordering a
  // selected muscle inside .regions can never push it over the line work.
  const layer = svgEl('g', { class: 'regions' });
  for (const region of regions) addRegion(layer, region);

  const lines = svgEl('g', { class: 'detail' });
  for (const d of detail) {
    lines.appendChild(svgEl('path', { d, class: 'detail-line' }));
    lines.appendChild(svgEl('path', { d, class: 'detail-line', transform: `translate(${VIEW.w},0) scale(-1,1)` }));
  }

  svg.append(layer, lines);
  // The authored order is the anatomical stacking order; keep a copy so the
  // selected muscle can be lifted to the front and then put back again.
  drawOrder = [...layer.children];
  el.stage.replaceChildren(svg);
  paintSelection();
}

function paintSelection() {
  const svg = el.stage.querySelector('svg');
  if (!svg) return;

  svg.classList.toggle('has-selection', state.selected !== null);
  for (const path of svg.querySelectorAll('.region.muscle')) {
    const on = path.dataset.group === state.selected;
    path.classList.toggle('selected', on);
    path.setAttribute('aria-pressed', String(on));
  }

  // Lift the selected muscle above its neighbours. Without this a muscle that
  // is anatomically underneath another — the lat under the rhomboids — lights
  // up with a dimmed patch sitting on top of it, and reads as hollow.
  const layer = svg.querySelector('.regions');
  const selected = drawOrder.filter((p) => p.classList.contains('selected'));
  layer.replaceChildren(...drawOrder.filter((p) => !selected.includes(p)), ...selected);

  drawPrompt();
}

function drawPrompt() {
  if (!state.selected) {
    el.prompt.className = 'prompt idle';
    el.prompt.replaceChildren(document.createTextNode('Tap a muscle to highlight it'));
    return;
  }

  const muscle = MUSCLES[state.selected];
  el.prompt.className = 'prompt';

  const label = document.createElement('div');
  label.className = 'picked';
  label.append(muscle.name);
  const latin = document.createElement('em');
  latin.textContent = muscle.latin;
  label.append(latin);

  const clear = document.createElement('button');
  clear.className = 'ghost';
  clear.type = 'button';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => { state.selected = null; paintSelection(); });

  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Details';
  open.addEventListener('click', () => openSheet(state.selected));

  el.prompt.replaceChildren(label, clear, open);
}

// ------------------------------------------------------------- interaction

// First tap highlights. Second tap on the same muscle opens it. Tapping a
// different muscle just moves the highlight.
function tapMuscle(group) {
  if (state.selected === group) {
    openSheet(group);
  } else {
    state.selected = group;
    paintSelection();
  }
}

el.stage.addEventListener('click', (e) => {
  const path = e.target.closest('[data-group]');
  if (path) tapMuscle(path.dataset.group);
});

el.stage.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const path = e.target.closest('[data-group]');
  if (!path) return;
  e.preventDefault();
  tapMuscle(path.dataset.group);
});

for (const button of el.toggle) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    for (const b of el.toggle) b.setAttribute('aria-pressed', String(b === button));
    // A muscle that does not exist on the new view cannot stay highlighted.
    const visible = state.view === 'front' ? FRONT_GROUPS : BACK_GROUPS;
    if (state.selected && !visible.includes(state.selected)) state.selected = null;
    drawFigure();
  });
}

// -------------------------------------------------------------------- sheet

function section(title, node) {
  const wrap = document.createElement('section');
  wrap.className = 'sect';
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.append(h, node);
  return wrap;
}

function bulletList(items) {
  const ul = document.createElement('ul');
  ul.className = 'plain';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function exerciseCard(ex) {
  const card = document.createElement('article');
  card.className = 'ex';

  const top = document.createElement('div');
  top.className = 'ex-top';
  const name = document.createElement('h4');
  name.textContent = ex.name;
  const badge = document.createElement('span');
  badge.className = `badge ${ex.kind}`;
  badge.textContent = ex.kind;
  top.append(name, badge);

  const meta = document.createElement('div');
  meta.className = 'ex-meta';
  const dose = document.createElement('span');
  dose.className = 'dose';
  dose.textContent = ex.dose;
  const kit = document.createElement('span');
  kit.textContent = ex.equipment;
  meta.append(dose, kit);

  const why = document.createElement('p');
  why.className = 'ex-why';
  why.textContent = ex.why;

  card.append(top, meta, why);
  return card;
}

function openSheet(group) {
  const muscle = MUSCLES[group];
  state.open = group;
  state.selected = group;
  paintSelection();

  const heading = document.createElement('div');
  const h2 = document.createElement('h2');
  h2.textContent = muscle.name;
  const latin = document.createElement('p');
  latin.className = 'latin';
  latin.textContent = muscle.latin;
  heading.append(h2, latin);
  if (muscle.heads) {
    const heads = document.createElement('p');
    heads.className = 'heads';
    heads.textContent = muscle.heads;
    heading.append(heads);
  }

  const close = document.createElement('button');
  close.className = 'closebtn';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', closeSheet);

  el.sheetHead.replaceChildren(heading, close);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = muscle.training;

  const exercises = document.createElement('div');
  for (const ex of muscle.exercises) exercises.appendChild(exerciseCard(ex));

  el.sheetBody.replaceChildren(
    section('What it does', bulletList(muscle.actions)),
    section('Where you use it in normal life', bulletList(muscle.everyday)),
    section('How to train it', note),
    section(`Exercises that target it · ${muscle.exercises.length}`, exercises),
  );
  el.sheetBody.scrollTop = 0;

  showSheet();
}

function openBrowser() {
  state.open = '__browse';

  const heading = document.createElement('div');
  const h2 = document.createElement('h2');
  h2.textContent = 'All muscle groups';
  const latin = document.createElement('p');
  latin.className = 'latin';
  latin.textContent = `${Object.keys(MUSCLES).length} groups`;
  heading.append(h2, latin);

  const close = document.createElement('button');
  close.className = 'closebtn';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', closeSheet);

  el.sheetHead.replaceChildren(heading, close);

  const grid = document.createElement('div');
  grid.className = 'list';
  for (const [id, muscle] of Object.entries(MUSCLES)) {
    const button = document.createElement('button');
    button.type = 'button';
    const name = document.createElement('strong');
    name.textContent = muscle.name;
    const latinName = document.createElement('span');
    latinName.textContent = muscle.latin;
    button.append(name, latinName);
    button.addEventListener('click', () => {
      // Jump to the view that actually shows this one before opening it.
      if (!(state.view === 'front' ? FRONT_GROUPS : BACK_GROUPS).includes(id)) {
        const target = FRONT_GROUPS.includes(id) ? 'front' : 'back';
        for (const b of el.toggle) b.setAttribute('aria-pressed', String(b.dataset.view === target));
        state.view = target;
        drawFigure();
      }
      openSheet(id);
    });
    grid.appendChild(button);
  }

  el.sheetBody.replaceChildren(grid);
  el.sheetBody.scrollTop = 0;
  showSheet();
}

function showSheet() {
  el.sheet.classList.add('open');
  el.scrim.classList.add('open');
  el.sheet.removeAttribute('aria-hidden');
  el.sheet.querySelector('.closebtn')?.focus({ preventScroll: true });
}

function closeSheet() {
  state.open = null;
  el.sheet.classList.remove('open');
  el.scrim.classList.remove('open');
  el.sheet.setAttribute('aria-hidden', 'true');
}

el.scrim.addEventListener('click', closeSheet);
el.browse.addEventListener('click', openBrowser);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.open) closeSheet();
});

drawFigure();
