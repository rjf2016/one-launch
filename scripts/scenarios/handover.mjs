// The launcher needs the user. Steam's remembered session for user_3 has expired, so after the restart Steam sits on
// its sign-in form: the attention panel appears with Copy login and Copy password (both land in the fake clipboard
// recorder, never the real clipboard), Stop waiting ends the job, and a second try runs into the needs-sign-in
// timeout. Then Epic: an expired session where the "user" signs in by hand and the switch finishes on its own.
import { finishDialog, journalExists, startPlay, watchDialog } from './lib.mjs';

const EPIC_ALT = '2'.repeat(32);

export const name = 'handover';
export const options = {
  fake: 'all-four',
  knobs: {
    knobs: {
      steam: { expiredSessions: ['user_3'] },
      epic: { expired: [EPIC_ALT], signInWhenAskedMs: 3_000, signInAs: EPIC_ALT },
    },
    timing: { steam: { signInMs: 2_000, manualSignInMs: 12_000 }, epic: { signInMs: 2_000 } },
  },
};

export default async (d) => {
  await d.waitFor('Rocket League');

  await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'stop-waiting' });
  let text = await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'stop-waiting' });
  d.check('the panel says Steam is asking for the sign-in', text.includes('Steam is asking you to sign in as user_3'));
  d.check(
    'the panel lists what to do, with the box as its own step',
    text.includes('In the Steam window, enter the account name user_3 and your password.') && text.includes('Keep “Remember me” ticked.'),
  );
  d.check('the footer says it is waiting in Steam', text.includes('Waiting for you in Steam…'));
  d.check('the Stop button gives way to Stop waiting', !/\nStop\n/.test(text));
  await d.shot('attention');
  await d.click('Copy login');
  await d.waitFor('Login copied');
  await d.click('Copy password');
  await d.waitFor('Password copied');
  await d.shot('attention-copied');
  const report = d.fakeReport();
  d.check('both copies went to the fake clipboard recorder', report.clipboardWrites === 2, String(report.clipboardWrites));
  d.check('the password copy was kept out of clipboard history', !(await d.has('clipboard history may keep it')));
  await d.click('Stop waiting');
  text = await watchDialog(d, { until: (t) => t.includes('Stopped waiting'), tag: 'stop-waiting' });
  d.check('Stop waiting: Steam is left on its form', text.includes('Stopped waiting for the sign-in as user_3. Steam was left on its sign-in form'));
  d.check('Stop waiting: nothing rolled back', text.includes('Nothing was rolled back. Once Steam is signed in, press Play again to launch the game.'));
  await finishDialog(d, 'stop-waiting');
  d.check('the journal is gone', !journalExists(d));

  await startPlay(d, { game: 'Rocket League', account: 'Persona Three', tag: 'timeout' });
  text = await watchDialog(d, { until: (t) => t.includes('gave up'), tag: 'timeout', timeoutMs: 90_000 });
  d.check(
    'the timeout says One Launch gave up and Steam is still on its form',
    /waited .* for the sign-in as user_3 and gave up\. Steam is still on its sign-in form/.test(text),
  );
  await finishDialog(d, 'timeout');
  const { recent } = await d.invoke('launch:recent', { limit: 10 });
  d.check('neither attempt counts as a launch', recent.length === 0);

  await startPlay(d, { game: 'Rocket League®', account: 'Alt', tag: 'epic-by-hand' });
  text = await watchDialog(d, { until: (t) => t.includes('Stop waiting'), tag: 'epic-by-hand' });
  d.check('Epic hands over after the expired session', text.includes('Epic Games Launcher is asking you to sign in as alt@example.com'));
  d.check('the Epic checklist is one step', text.includes('Sign in as alt@example.com in the Epic Games Launcher window.'));
  await d.shot('epic-attention');
  text = await watchDialog(d, { until: (t) => t.includes('Launched as'), tag: 'epic-by-hand' });
  await finishDialog(d, 'epic-by-hand');
  d.check('the manual sign-in finished the switch', text.includes('Launched as Alt'));
  const { accounts } = await d.invoke('accounts:list');
  const alt = accounts.find((a) => a.launcher === 'epic' && a.displayName === 'Alt');
  const { session } = await d.invoke('sessions:get', { accountId: alt.id });
  d.check(
    'the fresh session was stored and verified',
    session !== null && session.verifiedAt !== null && session.staleReason === null,
    JSON.stringify(session),
  );
  d.check(
    'the Epic launch went out',
    d.fakeReport().opened.some((u) => u.startsWith('com.epicgames.launcher://')),
  );
};
