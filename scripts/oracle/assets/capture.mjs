// Runtime half of the assets: the tray PNGs (a bare Electron script) and, from the running app on fake launchers, the token
// values as getComputedStyle gives them and the computed styles of the primitives under forced pseudo states.
//   node scripts/oracle/assets/capture.mjs [--out <bundle>] [--only=tray|app]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';
import { ORACLE_CLOCK, ShotDriver, scratchBase, sleep } from '../ui/kit.mjs';
import { STYLES, cssColor } from '../ui/sidecar.mjs';
import { RUNTIME_FILE, STATES_FILE, TRAY_DIR } from './runtime-files.mjs';
import { readTokens } from './tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ELECTRON = join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

function captureTray(out) {
  const scratch = join(scratchBase(), 'assets-tray');
  rmSync(scratch, { recursive: true, force: true });
  const profile = join(scratch, 'profile');
  const made = join(scratch, 'out');
  mkdirSync(profile, { recursive: true });
  const env = { ...process.env, TEMP: scratch, TMP: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(ELECTRON, [join(here, 'tray.cjs'), profile, made], { env, encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) throw new Error(`tray.cjs left with ${run.status}: ${run.stderr}`);
  const report = JSON.parse(readFileSync(join(made, 'tray.json'), 'utf8'));
  for (const name of readdirSync(made).filter((n) => n.endsWith('.png'))) writeArtefact(out, `${TRAY_DIR}/${name}`, readFileSync(join(made, name)));
  rmSync(scratch, { recursive: true, force: true });
  return report;
}

const PROBE = `(tokens) => {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'fixed';
  probe.style.left = '-9999px';
  probe.style.width = '40px';
  probe.style.height = '40px';
  document.body.appendChild(probe);
  const root = getComputedStyle(document.documentElement);
  const out = [];
  for (const t of tokens) {
    const custom = root.getPropertyValue(t.name).trim();
    probe.className = '';
    probe.removeAttribute('style');
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.width = '40px';
    probe.style.height = '40px';
    let computed = null;
    let via = null;
    if (t.kind === 'color') {
      probe.style.color = 'var(' + t.name + ')';
      computed = getComputedStyle(probe).color;
      via = 'color: var(' + t.name + ') on a probe element';
    } else if (t.kind === 'radius') {
      probe.className = t.utility;
      computed = getComputedStyle(probe).borderTopLeftRadius;
      via = 'border-top-left-radius of a probe with class ' + t.utility;
    } else if (t.kind === 'shadow') {
      probe.className = t.utility;
      computed = getComputedStyle(probe).boxShadow;
      via = 'box-shadow of a probe with class ' + t.utility;
    } else if (t.kind === 'font') {
      probe.className = t.utility;
      computed = getComputedStyle(probe).fontFamily;
      via = 'font-family of a probe with class ' + t.utility;
    }
    out.push({ name: t.name, custom, computed, via });
  }
  const body = getComputedStyle(document.body);
  probe.remove();
  return { tokens: out, body: { fontFamily: body.fontFamily, fontSize: body.fontSize, lineHeight: body.lineHeight, color: body.color, backgroundColor: body.backgroundColor } };
}`;

const utilityOf = (token) =>
  token.kind === 'radius'
    ? `rounded-${token.name.slice('--radius-'.length)}`
    : token.kind === 'shadow'
      ? `shadow-${token.name.slice('--shadow-'.length)}`
      : token.kind === 'font'
        ? `font-${token.name.slice('--font-'.length)}`
        : null;

// The primitives: the class signatures the sidecars show most, each found on a page it is on, by what only it has.
export const PRIMITIVES = [
  {
    name: 'nav-item',
    page: 'Library',
    states: ['hover', 'focus-visible', 'active'],
    find: `[...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === 'Accounts')`,
  },
  {
    name: 'nav-item-current',
    page: 'Library',
    states: ['hover', 'focus-visible'],
    find: `[...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === 'Library')`,
  },
  { name: 'icon-button', page: 'Library', states: ['hover', 'focus-visible', 'active'], find: `document.querySelector('aside button.size-9')` },
  {
    name: 'button-secondary',
    page: 'Library',
    states: ['hover', 'focus-visible', 'active', 'disabled'],
    find: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Rescan')`,
  },
  {
    name: 'dropdown-trigger',
    page: 'Library',
    states: ['hover', 'focus-visible', 'active', 'disabled'],
    find: `[...document.querySelectorAll('button[aria-haspopup]')].find((b) => b.textContent.includes('Filter'))`,
  },
  { name: 'search-input', page: 'Library', states: ['hover', 'focus', 'disabled'], find: `document.querySelector('input[type="search"], input[placeholder]')` },
  { name: 'game-card', page: 'Library', states: ['hover', 'focus-within'], find: `document.querySelector('div.rounded-panel.group')` },
  {
    name: 'game-card-play',
    page: 'Library',
    states: ['hover', 'focus-visible', 'active'],
    find: `document.querySelector('div.rounded-panel.group button.block')`,
  },
  {
    name: 'card-menu-button',
    page: 'Library',
    states: ['hover', 'focus-visible', 'active'],
    find: `document.querySelector('div.rounded-panel.group button.absolute')`,
  },
  {
    name: 'menu-option',
    page: 'Library',
    open: `[...document.querySelectorAll('button[aria-haspopup]')].find((b) => b.textContent.includes('Filter')).click()`,
    states: ['hover', 'focus-visible', 'active'],
    find: `[...document.querySelectorAll('[role="option"]')].find((o) => o.getAttribute('aria-selected') !== 'true')`,
  },
  {
    name: 'button-primary',
    page: 'Accounts',
    states: ['hover', 'focus-visible', 'active', 'disabled'],
    find: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add account')`,
  },
  { name: 'list-row', page: 'Accounts', states: ['hover', 'focus-visible', 'active'], find: `document.querySelector('main button.w-full.text-left')` },
  {
    name: 'button-ghost',
    page: 'Account',
    open: `document.querySelector('main button.w-full.text-left').click()`,
    states: ['hover', 'focus-visible', 'active', 'disabled'],
    find: `[...document.querySelectorAll('main button')].find((b) => b.className.includes('text-muted hover:text-text hover:bg-surface-2'))`,
  },
  {
    name: 'button-danger',
    page: 'Account',
    states: ['hover', 'focus-visible', 'active', 'disabled'],
    find: `[...document.querySelectorAll('main button')].find((b) => b.className.includes('border-danger/40'))`,
  },
  {
    name: 'tab',
    page: 'Settings',
    states: ['hover', 'focus-visible', 'active'],
    find: `[...document.querySelectorAll('[role="tab"]')].find((b) => b.getAttribute('aria-selected') !== 'true')`,
  },
  { name: 'tab-selected', page: 'Settings', states: ['hover', 'focus-visible'], find: `document.querySelector('[role="tab"][aria-selected="true"]')` },
  { name: 'switch', page: 'Settings', states: ['hover', 'focus-visible', 'active', 'disabled'], find: `document.querySelector('[role="switch"]')` },
  {
    name: 'checkbox',
    page: 'Import',
    open: `(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === 'Accounts').click();
      await wait(400);
      [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Import').click();
      await wait(300);
      [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.includes('Steam')).click();
    })()`,
    states: ['hover', 'focus-visible', 'active', 'disabled'],
    find: `document.querySelector('[role="dialog"] input[type="checkbox"]:not(:disabled)')`,
  },
];

const FORCED = {
  hover: ['hover'],
  'focus-visible': ['focus', 'focus-visible'],
  focus: ['focus', 'focus-visible'],
  active: ['active', 'hover'],
  'focus-within': ['focus-within'],
};

function record(computed) {
  const map = Object.fromEntries(computed.map((p) => [p.name, p.value]));
  const out = {};
  for (const name of [...STYLES, 'cursor']) {
    const value = map[name];
    if (value === undefined) continue;
    out[name] = /color$/.test(name) && /\(/.test(value) ? cssColor(value) : value.replace(/(rgba?|oklab|oklch|color)\([^()]*\)/g, (c) => cssColor(c));
  }
  return out;
}

const diff = (base, next) => Object.fromEntries(Object.entries(next).filter(([k, v]) => base[k] !== v));

async function computedSettled(d, nodeId) {
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    await d.evaluate(
      `(() => { for (const a of document.getAnimations()) { try { if (a.effect?.getComputedTiming?.().iterations !== Infinity) a.finish(); } catch {} } })()`,
    );
    const { computedStyle } = await d.send('CSS.getComputedStyleForNode', { nodeId });
    const now = JSON.stringify(record(computedStyle));
    if (now === last) return JSON.parse(now);
    last = now;
    await sleep(80);
  }
  throw new Error('the computed style kept changing');
}

async function onPage(d, title) {
  const deadline = Date.now() + 10_000;
  const probe = `(() => { const h = document.querySelector('main h1'); return Boolean(h && h.textContent.trim() === ${JSON.stringify(title)}); })()`;
  while (!(await d.evaluate(probe))) {
    if (Date.now() > deadline) throw new Error(`the ${title} page did not open`);
    await sleep(100);
  }
}

export async function captureApp({ primitives = PRIMITIVES, slot = 'assets-app' } = {}) {
  const d = new ShotDriver({ name: 'assets-styles', slot, fake: 'all-four', knobs: null, env: {}, args: [], holds: [], readyText: 'Library' });
  try {
    await d.start();
    await d.send('DOM.enable');
    await d.send('CSS.enable');
    const { tokens: declared } = readTokens();
    const asked = declared.map((t) => ({ name: t.name, kind: t.kind, utility: utilityOf(t) }));
    const tokens = await d.evaluate(`(${PROBE})(${JSON.stringify(asked)})`);
    await d.evaluate(`document.activeElement && document.activeElement.blur()`);
    await d.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    const states = [];
    let page = null;
    for (const primitive of primitives) {
      if (primitive.open || primitive.page !== page) {
        if (primitive.open) await d.evaluate(primitive.open);
        else {
          await d.click(primitive.page);
          await onPage(d, primitive.page);
        }
        await sleep(300);
        page = primitive.page;
        await d.evaluate(`document.activeElement && document.activeElement.blur()`);
        await d.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      }
      let found = null;
      for (let tries = 0; tries < 50 && !found; tries += 1) {
        if (tries > 0) await sleep(100);
        found = await d.evaluate(
          `(() => { document.querySelectorAll('[data-oracle-probe]').forEach((e) => e.removeAttribute('data-oracle-probe')); const el = ${primitive.find}; if (!el) return null; el.setAttribute('data-oracle-probe', ${JSON.stringify(primitive.name)}); return { tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') ?? '', text: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60) }; })()`,
        );
      }
      if (!found) throw new Error(`primitive ${primitive.name}: nothing on the ${primitive.page} page matches`);
      const { root } = await d.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await d.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-oracle-probe="${primitive.name}"]` });
      await d.send('DOM.removeAttribute', { nodeId, name: 'data-oracle-probe' });
      const normal = await computedSettled(d, nodeId);
      const result = { name: primitive.name, page: primitive.page, tag: found.tag, cls: found.cls, label: found.text, normal, states: {} };
      for (const state of primitive.states) {
        if (state === 'disabled') {
          await d.send('DOM.setAttributeValue', { nodeId, name: 'disabled', value: '' });
          const styled = await computedSettled(d, nodeId);
          await d.send('DOM.removeAttribute', { nodeId, name: 'disabled' });
          result.states.disabled = { how: 'the disabled attribute set on the element, then removed', changes: diff(normal, styled) };
          continue;
        }
        await d.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: FORCED[state] });
        const styled = await computedSettled(d, nodeId);
        await d.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        result.states[state] = { how: `CSS.forcePseudoState ${FORCED[state].join(', ')}`, changes: diff(normal, styled) };
      }
      await computedSettled(d, nodeId);
      states.push(result);
      console.log(`STATE ${primitive.name}  ${Object.keys(result.states).join(', ')}`);
    }
    return { tokens, states };
  } finally {
    await d.close().catch(() => d.killHard());
    rmSync(d.scratch, { recursive: true, force: true });
  }
}

async function main(argv) {
  const out = resolveOut(argv);
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
  const electronVersion = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  if (only === null || only === 'tray') {
    const tray = captureTray(out);
    writeArtefact(out, `${TRAY_DIR}/tray.json`, {
      source: 'build/icon.png',
      sourceSize: tray.source,
      code: 'src/main/tray.ts: nativeImage.createFromPath(iconPath).resize({ width: px, height: px }) with px = max(16, round(16 * scaleFactor))',
      electron: tray.electron,
      sizes: tray.made.map((m) => ({ px: m.px, firstScaleFactor: m.scaleFactor, file: `${TRAY_DIR}/tray-${m.px}.png` })),
    });
    console.log(`TRAY  ${tray.made.length} sizes`);
  }
  if (only === null || only === 'app') {
    const { tokens, states } = await captureApp();
    writeArtefact(out, RUNTIME_FILE, { electron: electronVersion, clock: ORACLE_CLOCK, locale: 'en-US', fake: 'all-four', viewport: [1280, 800], ...tokens });
    writeArtefact(out, STATES_FILE, {
      electron: electronVersion,
      clock: ORACLE_CLOCK,
      viewport: [1280, 800],
      properties: [...STYLES, 'cursor'],
      primitives: states,
    });
    console.log(`APP   ${tokens.tokens.length} tokens, ${states.length} primitives`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.stack ?? err.message);
    process.exitCode = 1;
  });
}
