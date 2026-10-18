import type { WhatsNewRelease } from './whats-new';

/**
 * What each release tells the user the first time One Launch opens after that update, and the GitHub release's notes
 * (scripts/release-notes.mjs renders the entry; the release workflow refuses a version without one). Newest first. An
 * `image` is a file in src/renderer/src/assets/whats-new/, shown at the top. Each section is a heading in one of the
 * palette tones over its changes; a change has a bold `lead` and a plain `detail`.
 */
export const WHATS_NEW: readonly WhatsNewRelease[] = [
  {
    version: '1.0.0-beta.3',
    date: '2026-10-15',
    image: { file: 'beta-3.png', alt: 'The setup guide on a new install' },
    sections: [
      {
        heading: 'New Features',
        tone: 'success',
        items: [
          {
            lead: 'One Launch now tells you what changed.',
            detail: 'After an update, this card shows up to inform you of any new quirks or features.',
          },
        ],
      },
      {
        heading: 'Improved',
        tone: 'warning',
        items: [
          {
            lead: 'A clearer welcome for new installs.',
            detail: 'The setup guide opens with the same tagline as the rest of the app and gets to the point faster.',
          },
        ],
      },
    ],
  },
];
