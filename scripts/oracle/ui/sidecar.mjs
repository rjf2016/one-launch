export const STYLES = [
  'display',
  'visibility',
  'opacity',
  'position',
  'overflow-x',
  'overflow-y',
  'transform',
  'color',
  'background-color',
  'background-image',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-decoration-line',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'box-shadow',
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
];

export const SNAPSHOT_PARAMS = { computedStyles: STYLES, includePaintOrder: true, includeDOMRects: true };

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'treeitem',
]);

const STRUCTURE = new Set([
  'dialog',
  'alertdialog',
  'menu',
  'menubar',
  'tablist',
  'tabpanel',
  'navigation',
  'banner',
  'main',
  'complementary',
  'region',
  'status',
  'alert',
  'heading',
  'image',
  'progressbar',
  'group',
  'toolbar',
  'separator',
  'form',
  'search',
  'tooltip',
  'list',
  'listitem',
]);

const GRAPHIC_TAGS = new Set(['svg', 'img', 'canvas', 'video']);

// Text that is not the same from one capture to the next: a clock time, a timestamp-shaped id, a duration in milliseconds.
export const VOLATILE_PATTERNS = [/\b\d{1,2}:\d{2}(:\d{2})?\s?[AP]M\b/i, /\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}/, /-?\b\d+(\.\d+)?\s?ms\b/];

// A relative time that has left "just now": the next capture would read another number.
export const AGED_PATTERN = /\b(\d+ (second|minute)s? ago|in \d+ (second|minute)s?)\b/;

const round = (value) => Math.round(value * 100) / 100;
const px = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};
const hex2 = (channel) =>
  Math.min(255, Math.max(0, Math.round(channel)))
    .toString(16)
    .padStart(2, '0');

function toHex(r, g, b, alpha) {
  const a = alpha === undefined ? 1 : alpha;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a >= 0.999 ? '' : hex2(a * 255)}`;
}

const gamma = (linear) => 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.max(0, linear) ** (1 / 2.4) - 0.055);

function oklabToHex(lightness, a, b, alpha) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return toHex(
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  );
}

const amount = (part, scale = 1) => (part === 'none' ? 0 : part.endsWith('%') ? (Number.parseFloat(part) / 100) * scale : Number.parseFloat(part));

export function cssColor(value) {
  const match = /^([a-z-]+)\((.*)\)$/.exec(value.trim());
  if (!match) throw new Error(`a colour the sidecar cannot read: ${value}`);
  const [main, alphaPart] = match[2].split('/').map((part) => part.trim());
  const parts = main.split(/[\s,]+/).filter(Boolean);
  let alpha = alphaPart === undefined ? 1 : amount(alphaPart);
  const fn = match[1];
  if (fn === 'rgb' || fn === 'rgba') {
    if (alphaPart === undefined && parts.length === 4) alpha = amount(parts[3]);
    return toHex(amount(parts[0], 255), amount(parts[1], 255), amount(parts[2], 255), alpha);
  }
  if (fn === 'color' && parts[0] === 'srgb') return toHex(amount(parts[1]) * 255, amount(parts[2]) * 255, amount(parts[3]) * 255, alpha);
  if (fn === 'oklab') return oklabToHex(amount(parts[0]), amount(parts[1], 0.4), amount(parts[2], 0.4), alpha);
  if (fn === 'oklch') {
    const chroma = amount(parts[1], 0.4);
    const hue = (Number.parseFloat(parts[2]) * Math.PI) / 180;
    return oklabToHex(amount(parts[0]), chroma * Math.cos(hue), chroma * Math.sin(hue), alpha);
  }
  throw new Error(`a colour the sidecar cannot read: ${value}`);
}

const isClear = (hex) => hex.length === 9 && hex.endsWith('00');

const COLOUR_IN_VALUE = /\b(rgba?|oklab|oklch|color)\([^()]*\)/g;
const withHexColours = (value) => value.replace(COLOUR_IN_VALUE, (colour) => cssColor(colour));
// Tailwind composes a shadow from five layers and leaves the unused ones in as transparent zero-size shadows.
const shadowOf = (value) =>
  withHexColours(value)
    .split(/,\s*(?=#)/)
    .filter((layer) => !/^#[0-9a-f]{6}00 0px 0px 0px 0px$/.test(layer.trim()))
    .join(', ');

export function isVolatile(text, extra = []) {
  return [...VOLATILE_PATTERNS, ...extra].some((pattern) => pattern.test(text));
}

function intersect(a, b) {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x, y, Math.max(0, right - x), Math.max(0, bottom - y)];
}

const firstFamily = (list) =>
  list
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');

export function buildSidecar({ snapshot, ax, meta, volatile = [] }) {
  const strings = snapshot.strings;
  const doc = snapshot.documents[0];
  const { nodes, layout, textBoxes } = doc;
  const str = (index) => (index === undefined || index < 0 ? '' : strings[index]);
  const count = nodes.parentIndex.length;
  const viewport = [0, 0, meta.viewport[0], meta.viewport[1]];

  const layoutOf = new Array(count).fill(-1);
  layout.nodeIndex.forEach((nodeIndex, li) => {
    layoutOf[nodeIndex] = li;
  });
  const styleOf = (nodeIndex) => {
    const li = layoutOf[nodeIndex];
    const values = li === -1 ? [] : layout.styles[li];
    if (values.length !== STYLES.length) return null;
    return Object.fromEntries(STYLES.map((name, i) => [name, str(values[i])]));
  };
  const styles = Array.from({ length: count }, (_, i) => styleOf(i));
  const tagOf = (i) => str(nodes.nodeName[i]).toLowerCase();
  const attributesOf = (i) => {
    const pairs = nodes.attributes[i] ?? [];
    const out = {};
    for (let k = 0; k < pairs.length; k += 2) out[str(pairs[k])] = str(pairs[k + 1]);
    return out;
  };
  const pseudo = new Map((nodes.pseudoType?.index ?? []).map((nodeIndex, k) => [nodeIndex, str(nodes.pseudoType.value[k])]));
  const inputValue = new Map((nodes.inputValue?.index ?? []).map((nodeIndex, k) => [nodeIndex, str(nodes.inputValue.value[k])]));

  const opacity = new Array(count).fill(null);
  const opacityOf = (i) => {
    if (i < 0) return 1;
    if (opacity[i] === null) opacity[i] = opacityOf(nodes.parentIndex[i]) * (styles[i] ? Number.parseFloat(styles[i].opacity) : 1);
    return opacity[i];
  };

  const paddingBox = (i) => {
    const li = layoutOf[i];
    const bounds = layout.bounds[li];
    const client = layout.clientRects?.[li];
    return client && client.length === 4 ? [bounds[0] + client[0], bounds[1] + client[1], client[2], client[3]] : bounds;
  };
  const clips = (i) => styles[i] !== null && (styles[i]['overflow-x'] !== 'visible' || styles[i]['overflow-y'] !== 'visible');
  const holdsAbsolute = (i) => styles[i] !== null && (styles[i].position !== 'static' || styles[i].transform !== 'none');
  const holdsFixed = (i) => styles[i] !== null && styles[i].transform !== 'none';
  // Only the boxes a node is laid out inside clip it: an absolute or fixed node skips the ancestors between it and its containing block.
  const clipOf = (nodeIndex) => {
    let rect = viewport;
    let position = styles[nodeIndex]?.position ?? 'static';
    for (let i = nodes.parentIndex[nodeIndex]; i >= 0; i = nodes.parentIndex[i]) {
      if (styles[i] === null) continue;
      if (position === 'fixed' && !holdsFixed(i)) continue;
      if (position === 'absolute' && !holdsAbsolute(i)) continue;
      if (clips(i)) rect = intersect(rect, paddingBox(i));
      position = styles[i].position;
    }
    return rect;
  };
  const shown = (nodeIndex, box) => {
    const style = styles[nodeIndex] ?? styles[nodes.parentIndex[nodeIndex]];
    if (!style || style.visibility !== 'visible' || style.display === 'none') return false;
    const seen = intersect(box, clipOf(nodeIndex));
    return seen[2] > 0 && seen[3] > 0;
  };

  const text = [];
  const boxesByLayout = new Map();
  textBoxes.layoutIndex.forEach((li, k) => {
    if (!boxesByLayout.has(li)) boxesByLayout.set(li, []);
    boxesByLayout.get(li).push(k);
  });
  layout.nodeIndex.forEach((nodeIndex, li) => {
    if (layout.text[li] === undefined || layout.text[li] < 0) return;
    const whole = str(layout.text[li]);
    const style = styles[nodeIndex] ?? styles[nodes.parentIndex[nodeIndex]];
    if (!style) return;
    const runs = boxesByLayout.has(li)
      ? boxesByLayout.get(li).map((k) => ({ t: whole.substr(textBoxes.start[k], textBoxes.length[k]), box: textBoxes.bounds[k] }))
      : [{ t: whole, box: layout.bounds[li] }];
    const fade = opacityOf(nodeIndex);
    for (const run of runs) {
      if (run.t.trim() === '' || fade <= 0 || !shown(nodeIndex, run.box)) continue;
      const size = px(style['font-size']);
      const item = {
        t: run.t,
        box: run.box.map(round),
        font: [
          firstFamily(style['font-family']),
          size,
          Number(style['font-weight']),
          style['line-height'] === 'normal' ? round(run.box[3]) : round(px(style['line-height'])),
        ],
        color: cssColor(style.color),
        volatile: isVolatile(run.t, volatile),
      };
      if (fade < 0.999) item.opacity = round(fade);
      if (style['letter-spacing'] !== 'normal' && px(style['letter-spacing']) !== 0) item.tracking = round(px(style['letter-spacing']));
      if (style['text-decoration-line'] !== 'none') item.deco = style['text-decoration-line'];
      text.push(item);
    }
  });

  const byBackend = new Map(nodes.backendNodeId.map((backendId, i) => [backendId, i]));
  const axOf = new Map();
  let focus = null;
  for (const node of ax.nodes) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    const nodeIndex = byBackend.get(node.backendDOMNodeId);
    const role = node.role?.value ?? '';
    const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value]));
    const name = (node.name?.value ?? '').replace(/\s+/g, ' ').trim();
    if (props.focused === true && role !== 'RootWebArea') focus = `${role}:${name}`;
    if (nodeIndex === undefined || axOf.has(nodeIndex)) continue;
    axOf.set(nodeIndex, { role, name, props, description: (node.description?.value ?? '').replace(/\s+/g, ' ').trim() });
  }

  const insideGraphic = (i) => {
    for (let p = nodes.parentIndex[i]; p >= 0; p = nodes.parentIndex[p]) if (tagOf(p) === 'svg') return true;
    return false;
  };
  const sides = ['top', 'right', 'bottom', 'left'];
  const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const styleRecord = (style, box, withFont) => {
    const out = {};
    const bg = cssColor(style['background-color']);
    if (!isClear(bg)) out.bg = bg;
    if (style['background-image'] !== 'none') out.bgImage = withHexColours(style['background-image'].replace(/url\([^)]*\)/g, 'url()'));
    out.color = cssColor(style.color);
    const widths = sides.map((side) => (style[`border-${side}-style`] === 'none' ? 0 : px(style[`border-${side}-width`])));
    if (widths.some((w) => w > 0)) {
      out.border = widths;
      const colours = sides.map((side) => cssColor(style[`border-${side}-color`]));
      out.borderColor = colours.every((c) => c === colours[0]) ? colours[0] : colours;
    }
    const limit = Math.min(box[2], box[3]) / 2;
    const radii = corners.map((corner) => {
      const value = style[`border-${corner}-radius`].split(' ')[0];
      return round(Math.min(limit, value.endsWith('%') ? (Number.parseFloat(value) / 100) * Math.min(box[2], box[3]) : px(value)));
    });
    if (radii.some((r) => r > 0)) out.radius = radii.every((r) => r === radii[0]) ? radii[0] : radii;
    const padding = sides.map((side) => px(style[`padding-${side}`]));
    if (padding.some((p) => p > 0)) out.padding = padding;
    const shadow = style['box-shadow'] === 'none' ? '' : shadowOf(style['box-shadow']);
    if (shadow !== '') out.shadow = shadow;
    if (style['outline-style'] !== 'none' && px(style['outline-width']) > 0)
      out.outline = [px(style['outline-width']), cssColor(style['outline-color']), px(style['outline-offset'])];
    if (withFont)
      out.font = [
        firstFamily(style['font-family']),
        px(style['font-size']),
        Number(style['font-weight']),
        style['line-height'] === 'normal' ? null : round(px(style['line-height'])),
      ];
    return out;
  };
  const decorated = (record) => 'bg' in record || 'bgImage' in record || 'border' in record || 'shadow' in record || 'outline' in record;

  const elements = [];
  const ordinals = new Map();
  for (let i = 0; i < count; i += 1) {
    const li = layoutOf[i];
    if (li === -1 || nodes.nodeType[i] !== 1 || styles[i] === null) continue;
    const box = layout.bounds[li];
    if (box[2] <= 0 || box[3] <= 0 || !shown(i, box)) continue;
    const tag = pseudo.has(i) ? `::${pseudo.get(i)}` : tagOf(i);
    if (tag === 'html' || tag === 'body' || insideGraphic(i)) continue;
    const node = axOf.get(i);
    const graphic = GRAPHIC_TAGS.has(tag);
    const listed = node !== undefined && (INTERACTIVE.has(node.role) || STRUCTURE.has(node.role));
    const record = styleRecord(styles[i], box, listed && INTERACTIVE.has(node.role));
    if (!listed && !graphic && !decorated(record)) continue;
    const role = listed ? node.role : graphic ? 'image' : 'generic';
    const name = listed || (graphic && node) ? node.name : '';
    const attributes = attributesOf(i);
    const props = node?.props ?? {};
    const state = {
      disabled: props.disabled === true,
      checked: props.checked === undefined ? null : props.checked === 'mixed' ? 'mixed' : props.checked === true || props.checked === 'true',
      expanded: props.expanded === undefined ? null : props.expanded === true,
    };
    if (props.selected !== undefined) state.selected = props.selected === true;
    if (props.pressed !== undefined) state.pressed = props.pressed === true || props.pressed === 'true';
    if (props.invalid !== undefined && props.invalid !== 'false') state.invalid = true;
    if (attributes['aria-current'] !== undefined) state.current = attributes['aria-current'];
    if (attributes['aria-busy'] === 'true') state.busy = true;
    const fade = opacityOf(i);
    if (fade < 0.999) record.opacity = round(fade);
    const key = `${role}\u0000${name}`;
    const ord = ordinals.get(key) ?? 0;
    ordinals.set(key, ord + 1);
    const item = { role, name, ord, box: box.map(round), state, style: record, cls: attributes.class ?? '', tag };
    if (tag === 'input' || tag === 'textarea') {
      const value = inputValue.get(i) ?? '';
      item.value = attributes.type === 'password' ? '•'.repeat([...value].length) : value;
      if (attributes.placeholder !== undefined) item.placeholder = attributes.placeholder;
    }
    if (node && node.description !== '' && node.description !== name) item.desc = node.description;
    if (isVolatile(`${name}\n${item.value ?? ''}\n${item.desc ?? ''}`, volatile)) item.volatile = true;
    elements.push(item);
  }

  const scroll = [];
  layout.nodeIndex.forEach((nodeIndex, li) => {
    const rect = layout.scrollRects?.[li];
    const client = layout.clientRects?.[li];
    if (!rect || rect.length !== 4 || !client || client.length !== 4 || styles[nodeIndex] === null || !clips(nodeIndex)) return;
    if (rect[2] <= client[2] + 0.5 && rect[3] <= client[3] + 0.5) return;
    if (!shown(nodeIndex, layout.bounds[li])) return;
    scroll.push({ box: paddingBox(nodeIndex).map(round), at: [round(rect[0]), round(rect[1])], size: [round(rect[2]), round(rect[3])] });
  });

  return {
    id: meta.id,
    name: meta.name,
    viewport: meta.viewport,
    dpr: 1,
    locale: meta.locale,
    tz: meta.tz,
    clock: meta.clock,
    focus,
    paused: meta.paused,
    scroll,
    text,
    elements,
  };
}

const line = (value) => JSON.stringify(value);

// One text run and one element per line: a sidecar holds hundreds, and a diff then shows the one that moved.
export function sidecarText(sidecar) {
  const { text, elements, scroll, ...head } = sidecar;
  const list = (items) => (items.length === 0 ? '[]' : `[\n${items.map((item) => `    ${line(item)}`).join(',\n')}\n  ]`);
  const lines = Object.entries(head).map(([key, value]) => `  ${line(key)}: ${line(value)}`);
  lines.push(`  "scroll": ${list(scroll)}`, `  "text": ${list(text)}`, `  "elements": ${list(elements)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

export function sidecarStrings(sidecar) {
  const out = [];
  const visit = (value) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(sidecar);
  return out;
}

export function maskVolatile(sidecar) {
  const masked = structuredClone(sidecar);
  for (const run of masked.text) {
    if (!run.volatile) continue;
    run.t = '<volatile>';
    run.box = [null, run.box[1], null, run.box[3]];
  }
  for (const element of masked.elements) {
    if (!element.volatile) continue;
    element.name = '<volatile>';
    if ('value' in element) element.value = '<volatile>';
    if ('desc' in element) element.desc = '<volatile>';
  }
  if (typeof masked.focus === 'string' && isVolatile(masked.focus)) masked.focus = '<volatile>';
  return masked;
}
