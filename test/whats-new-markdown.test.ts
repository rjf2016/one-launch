import { describe, expect, it } from 'vitest';
import type { WhatsNewRelease } from '../src/shared/whats-new';
import { renderWhatsNewMarkdown } from '../src/shared/whats-new-markdown';
import { WHATS_NEW } from '../src/shared/whats-new-releases';

const REPO = { owner: 'someone', repo: 'some-app' };

const full: WhatsNewRelease = {
  version: '1.2.3-beta.4',
  date: '2026-10-01',
  intro: 'A short word first.',
  image: { file: 'beta 4.png', alt: 'The library' },
  sections: [
    {
      heading: 'New',
      tone: 'success',
      items: [{ lead: 'One thing.', detail: 'With a detail.' }, { lead: 'Another thing.' }],
    },
    { heading: 'Fixed', items: [{ lead: 'A fix.' }] },
  ],
};

describe('renderWhatsNewMarkdown', () => {
  it('renders the image at the tag, the intro, and each section as a heading over bold leads', () => {
    expect(renderWhatsNewMarkdown(full, REPO)).toBe(
      [
        '![The library](https://github.com/someone/some-app/blob/v1.2.3-beta.4/src/renderer/src/assets/whats-new/beta%204.png?raw=true)',
        '',
        'A short word first.',
        '',
        '## New',
        '',
        '- **One thing.** With a detail.',
        '- **Another thing.**',
        '',
        '## Fixed',
        '',
        '- **A fix.**',
        '',
      ].join('\n'),
    );
  });

  it('leaves out the image and intro blocks when the entry has none', () => {
    const { image: _image, intro: _intro, ...bare } = full;
    const text = renderWhatsNewMarkdown(bare, REPO);
    expect(text.startsWith('## New\n\n- **One thing.**')).toBe(true);
    expect(text).not.toContain('![');
    expect(text).not.toContain('\n\n\n');
  });

  it('gives an image without alt text an empty alt', () => {
    const text = renderWhatsNewMarkdown({ ...full, image: { file: 'x.png' } }, REPO);
    expect(text.startsWith('![](https://github.com/someone/some-app/blob/v1.2.3-beta.4/')).toBe(true);
  });

  it('renders every entry in WHATS_NEW with each of its headings and leads', () => {
    for (const release of WHATS_NEW) {
      const text = renderWhatsNewMarkdown(release, REPO);
      for (const section of release.sections) {
        expect(text, release.version).toContain(`## ${section.heading}\n`);
        for (const item of section.items) expect(text, release.version).toContain(`- **${item.lead}**`);
      }
    }
  });
});
