// The What's New card. A fresh data folder never shows it (main records the running version as seen), a folder that last
// saw an older version shows it once and closing records the version, the next start shows nothing, the switch off keeps
// it closed and still records the version, and Settings shows it on request. The card needs an entry at or below the
// running version; without one the scenario checks only that nothing opens.
import { sleep } from '../app-driver.mjs';
import { pixelAt, skipSetup } from './lib.mjs';

export const name = 'whats-new';
export const options = { fake: 'none' };

const settle = () => sleep(900);

/** True when the list does not overflow yet the middle of its scrollbar track shows the thumb colour rather than the card. */
async function thumbWithoutOverflow(d) {
  const list = await d.evaluate(() => {
    const el = document.querySelector('[role="dialog"][aria-labelledby="whats-new-title"] .overflow-y-auto');
    const r = el.getBoundingClientRect();
    return { overflows: el.scrollHeight > el.clientHeight, x: Math.round(r.right - 6), y: Math.round(r.top + r.height / 2) };
  });
  if (list.overflows) return false;
  const [r, g, b] = await pixelAt(d, list.x, list.y);
  return Math.abs(r - 0x34) + Math.abs(g - 0x3a) + Math.abs(b - 0x4b) < 24;
}
const cardOpen = (d) => d.evaluate(() => document.querySelector('[role="dialog"][aria-labelledby="whats-new-title"]') !== null);
const waitForCard = (d, { absent = false } = {}) =>
  d.waitFor(() => document.querySelector('[role="dialog"][aria-labelledby="whats-new-title"]') !== null, { absent });
const lastSeen = async (d) => (await d.invoke('settings:getAll')).settings['whatsNew.lastSeen'] ?? null;

async function waitForLastSeen(d, version, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while ((await lastSeen(d)) !== version) {
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
  return true;
}

export default async (d) => {
  const { version } = await d.invoke('app:info');
  await skipSetup(d);
  await d.waitFor('Rescan');
  await sleep(1000);
  d.check('a fresh folder shows no card', !(await cardOpen(d)));
  const seeded = await lastSeen(d);
  d.check('a fresh folder counts the running version as seen', seeded === version, `${seeded} vs ${version}`);

  await d.click('Settings');
  await d.waitFor('Advanced');
  const hasNotes = await d.evaluate(() => {
    const button = document.querySelector('button[aria-label="Show what\'s new"]');
    return button !== null && !button.disabled;
  });

  await d.invoke('settings:set', { key: 'whatsNew.lastSeen', value: '0.0.0' });
  await d.restart();
  if (hasNotes) {
    await waitForCard(d);
    d.check(
      'an older last-seen version opens the card: a modal with the title, a date and the changes',
      await d.evaluate(() => {
        const card = document.querySelector('[role="dialog"][aria-modal="true"][aria-labelledby="whats-new-title"]');
        return card !== null && card.innerText.includes("What's New") && card.querySelectorAll('li').length > 0;
      }),
    );
    await settle();
    await d.shot('whats-new');
    await d.viewport(960, 600);
    await d.shot('whats-new-960x600');

    // A window grown in small steps must not leave a scrollbar thumb painted once the list fits (the gutter is always reserved,
    // so the thumb's pixel colour in the middle of the track is what tells a thumb from an empty track).
    let stale = null;
    for (let h = 600; h <= 1400 && !stale; h += 8) {
      await d.viewport(1400, h);
      await sleep(40);
      if (await thumbWithoutOverflow(d)) {
        await sleep(200);
        if (await thumbWithoutOverflow(d)) stale = h;
      }
    }
    d.check('a window grown in small steps leaves no scrollbar thumb once the list fits', stale === null, stale ? `thumb painted at h=${stale}` : '');
    await d.viewport(null);
    await d.click({ selector: '[aria-labelledby="whats-new-title"] button[aria-label="Close"]' });
    await waitForCard(d, { absent: true });
    d.check('closing records the running version as seen', await waitForLastSeen(d, version));

    await d.restart();
    await d.waitFor('Rescan');
    await sleep(1000);
    d.check('the next start shows no card', !(await cardOpen(d)));
  } else {
    await d.waitFor('Rescan');
    await sleep(1000);
    d.check('no entry for this version, so the card stays closed', !(await cardOpen(d)));
  }

  await d.invoke('settings:set', { key: 'whatsNew.enabled', value: 'false' });
  await d.invoke('settings:set', { key: 'whatsNew.lastSeen', value: '0.0.0' });
  await d.restart();
  await d.waitFor('Rescan');
  await sleep(1500);
  d.check('with the switch off the card stays closed', !(await cardOpen(d)));
  d.check('and the running version still counts as seen', await waitForLastSeen(d, version));

  if (hasNotes) {
    await d.click('Settings');
    await d.waitFor('Advanced');
    await d.click("Show what's new");
    await waitForCard(d);
    d.check('Settings shows the card on request', await cardOpen(d));
    await d.key('Escape');
    await waitForCard(d, { absent: true });
    d.check('Escape closes it', !(await cardOpen(d)));
  }
};
