import type { WhatsNewRelease } from './whats-new';

/**
 * What each release tells the user the first time One Launch opens after that update. Newest first. A release with an
 * entry here announces itself once; leave a release out and nobody is interrupted for it. An `image` is a file in
 * src/renderer/src/assets/whats-new/, shown at the top. In `items`, a `{ heading, tone }` entry is a separator above the
 * changes that follow it; a change has a bold `lead` and a plain `detail`.
 */
export const WHATS_NEW: readonly WhatsNewRelease[] = [
  {
    version: '1.0.0-beta.3',
    date: '2026-10-15',
    image: { file: 'beta-3.png', alt: 'The setup guide on a new install' },
    items: [
      { heading: 'New', tone: 'success' },
      {
        lead: 'One Launch now tells you what changed.',
        detail: 'After an update, this card shows up once. Settings › General turns it off, or shows it again.',
      },
      { heading: 'Improved', tone: 'accent' },
      {
        lead: 'A clearer welcome for new installs.',
        detail: 'The setup guide opens with the same tagline as the rest of the app and gets to the point faster.',
      },
    ],
  },
];
