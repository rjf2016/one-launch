import type { WhatsNewRelease } from './whats-new';

/**
 * What each release tells the user the first time One Launch opens after that update. Newest first. A release with an
 * entry here announces itself once; leave a release out and nobody is interrupted for it. `lead` is shown bold, `detail`
 * plain after it, and an optional `intro` sentence sits above the list.
 */
export const WHATS_NEW: readonly WhatsNewRelease[] = [
  {
    version: '1.0.0-beta.3',
    date: '2026-10-15',
    items: [
      {
        lead: 'One Launch now tells you what changed.',
        detail: 'After an update, this card shows up once. Settings › General turns it off, or shows it again.',
      },
      {
        lead: 'A clearer welcome for new installs.',
        detail: 'The setup guide opens with the same tagline as the rest of the app and gets to the point faster.',
      },
    ],
  },
];
