// Settles two capture assumptions against the running app, whose window is created with devTools:false:
// whether the layout-sidecar calls work, and whether the browser target lists the app's own process ids.
//   node scripts/oracle/spike/cdp-probe.mjs              the unpackaged build on fake launchers (npx electron-vite build first)
//   node scripts/oracle/spike/cdp-probe.mjs --packaged   dist/win-unpacked on a scratch data folder, reads only (npm run build first)
// Prints counts and role names only, never page text: a packaged run shows what this PC has installed.
import { execFileSync } from 'node:child_process';
import { parseArgs, runScenario, sleep } from '../../app-driver.mjs';

const STYLES = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-top-left-radius', 'padding-top'];

/** One call on the browser target, which is where SystemInfo lives; the page target the driver holds does not have it. */
async function browserCall(port, method, params = {}) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('could not open the browser target'));
  });
  try {
    return await new Promise((res, rej) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id !== 1) return;
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** Parent of each process id, asked of Windows by id and never by image name: the installed copy of the app may be running too. */
function parentsOf(pids) {
  const filter = pids.map((pid) => `ProcessId = ${Number(pid)}`).join(' OR ');
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return new Map(
    out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.trim().split(' ').map(Number)),
  );
}

const attempt = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

const probe = {
  name: 'cdp-probe',
  label: 'Capture spike: layout sidecar calls and process ids',
  default: async (d) => {
    await d.shot('kick');
    const info = await d.invoke('app:info');
    // A settled page: the fake library with its covers in, or the setup guide a new data folder opens.
    await d.waitFor(info.platformSource === 'fake' ? 'Rocket League' : 'Welcome to One Launch');
    await sleep(1_500);
    console.log(`PROBE app isPackaged=${info.isPackaged} electron=${info.electron} chrome=${info.chrome} platform=${info.platformSource}`);
    const opened = await attempt(d.send('Page.bringToFront'));
    const f12 = await d.evaluate(() => typeof window.devtools);
    console.log(`PROBE page target answers Page.bringToFront: ${opened.ok}; window.devtools in the page: ${f12}`);

    const snap = await attempt(d.send('DOMSnapshot.captureSnapshot', { computedStyles: STYLES, includePaintOrder: true, includeDOMRects: true }));
    d.check('DOMSnapshot.captureSnapshot answers', snap.ok, snap.error ?? '');
    let backendIds = [];
    if (snap.ok) {
      const doc = snap.value.documents[0];
      backendIds = doc.nodes.backendNodeId;
      const styled = doc.layout.styles.filter((s) => s.length === STYLES.length).length;
      console.log(
        `PROBE snapshot documents=${snap.value.documents.length} nodes=${doc.nodes.nodeName.length} layoutNodes=${doc.layout.nodeIndex.length} ` +
          `bounds=${doc.layout.bounds.length} styledNodes=${styled} paintOrders=${doc.layout.paintOrders?.length ?? 'absent'} ` +
          `textBoxes=${doc.textBoxes.layoutIndex.length} offsetRects=${doc.layout.offsetRects?.length ?? 'absent'} clientRects=${doc.layout.clientRects?.length ?? 'absent'} strings=${snap.value.strings.length}`,
      );
      d.check(
        'the snapshot carries layout, the whitelisted styles, paint order, text boxes and DOM rects',
        styled > 0 && doc.layout.paintOrders?.length > 0 && doc.textBoxes.layoutIndex.length > 0 && doc.layout.clientRects?.length > 0,
      );
    }

    const ax = await attempt(d.send('Accessibility.getFullAXTree'));
    d.check('Accessibility.getFullAXTree answers', ax.ok, ax.error ?? '');
    if (ax.ok) {
      const nodes = ax.value.nodes;
      const withDom = nodes.filter((n) => n.backendDOMNodeId !== undefined);
      const known = new Set(backendIds);
      const joined = withDom.filter((n) => known.has(n.backendDOMNodeId));
      const named = nodes.filter((n) => !n.ignored && n.role?.value === 'button' && n.name?.value);
      const roles = {};
      for (const n of nodes) if (!n.ignored) roles[n.role?.value] = (roles[n.role?.value] ?? 0) + 1;
      console.log(`PROBE ax nodes=${nodes.length} withBackendDOMNodeId=${withDom.length} joinedToSnapshot=${joined.length} namedButtons=${named.length}`);
      console.log(`PROBE ax roles ${JSON.stringify(roles)}`);
      // Where each AX node the snapshot does not list lives: the snapshot leaves out a form control's built-in shadow tree.
      const whereIs =
        'function () { const r = this.getRootNode(); return `${this.tagName} in ${r instanceof ShadowRoot ? `the shadow tree of ${r.host.tagName}` : "the document"}`; }';
      const loose = [];
      for (const n of withDom.filter((x) => !known.has(x.backendDOMNodeId))) {
        const object = await attempt(d.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId }));
        const where = object.ok
          ? await attempt(d.send('Runtime.callFunctionOn', { objectId: object.value.object.objectId, functionDeclaration: whereIs, returnByValue: true }))
          : object;
        loose.push({ role: `${n.role?.value}${n.ignored ? ' (ignored)' : ''}`, where: where.ok ? where.value.result.value : where.error });
      }
      console.log(
        `PROBE ax nodes with a DOM node the snapshot does not list: ${loose.length ? loose.map((l) => `${l.role} is ${l.where}`).join('; ') : 'none'}`,
      );
      d.check(
        'every AX node with a DOM node joins the snapshot on backendDOMNodeId, bar those inside a control’s built-in shadow tree',
        withDom.length > 0 &&
          joined.length + loose.length === withDom.length &&
          loose.every((l) => /in the shadow tree of (INPUT|TEXTAREA|SELECT)$/.test(l.where)),
        `${joined.length}/${withDom.length} joined, ${loose.length} in a shadow tree`,
      );
      d.check('buttons come back with a role and a name', named.length > 0);
    }

    const extras = {
      'Emulation.setLocaleOverride': await attempt(d.send('Emulation.setLocaleOverride', { locale: 'en-US' })),
      'Emulation.setTimezoneOverride': await attempt(d.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })),
      'DOM.enable': await attempt(d.send('DOM.enable')),
      'CSS.enable': await attempt(d.send('CSS.enable')),
      'Animation.enable': await attempt(d.send('Animation.enable')),
    };
    const root = await attempt(d.send('DOM.getDocument', { depth: 0 }));
    const button = root.ok ? await attempt(d.send('DOM.querySelector', { nodeId: root.value.root.nodeId, selector: 'button' })) : root;
    extras['CSS.forcePseudoState'] = button.ok
      ? await attempt(d.send('CSS.forcePseudoState', { nodeId: button.value.nodeId, forcedPseudoClasses: ['hover'] }))
      : button;
    const tz = await d.evaluate(() => `${Intl.DateTimeFormat().resolvedOptions().timeZone} ${Intl.DateTimeFormat().resolvedOptions().locale}`);
    console.log(
      `PROBE also ${Object.entries(extras)
        .map(([name, r]) => `${name}=${r.ok ? 'ok' : `ERROR ${r.error}`}`)
        .join(' ')}; the page now reports ${tz}`,
    );

    const onPage = await attempt(d.send('SystemInfo.getProcessInfo'));
    console.log(`PROBE SystemInfo.getProcessInfo on the page target: ${onPage.ok ? 'answers' : `refused (${onPage.error})`}`);
    const procs = await attempt(browserCall(d.port, 'SystemInfo.getProcessInfo'));
    d.check('SystemInfo.getProcessInfo answers on the browser target', procs.ok, procs.error ?? '');
    if (procs.ok) {
      const list = procs.value.processInfo;
      const browser = list.filter((p) => p.type === 'browser');
      const others = list.filter((p) => p.type !== 'browser');
      const parents = parentsOf(list.map((p) => p.id));
      const children = others.filter((p) => parents.get(p.id) === d.child.pid);
      console.log(
        `PROBE processes ${JSON.stringify(list.reduce((acc, p) => ({ ...acc, [p.type]: (acc[p.type] ?? 0) + 1 }), {}))} cpuTime present=${list.every((p) => typeof p.cpuTime === 'number')}`,
      );
      d.check(
        'the one browser entry is the process the driver started',
        browser.length === 1 && browser[0].id === d.child.pid,
        `${browser.length} browser entr${browser.length === 1 ? 'y' : 'ies'}`,
      );
      d.check(
        'every other entry is a child of that process, by Windows’ own parent ids',
        others.length > 0 && children.length === others.length,
        `${children.length}/${others.length}`,
      );
    }
  },
};

const { flags } = parseArgs(process.argv.slice(2));
const { failures } = await runScenario(probe, flags.packaged ? { packaged: true } : { fake: true });
process.exit(failures === 0 ? 0 : 1);
