import type { WhatsNewRelease } from './whats-new';

// Imported by scripts/release-notes.mjs through Node's type stripping, so it must stay free of local runtime imports and non-erasable syntax.

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export const WHATS_NEW_IMAGE_DIR = 'src/renderer/src/assets/whats-new';

/**
 * The GitHub release body for an entry: the card's image, intro and sections as Markdown. The image is linked at the
 * release's tag, so the link outlives later changes to the file. No version or date: the release title and GitHub supply those.
 */
export function renderWhatsNewMarkdown(release: WhatsNewRelease, { owner, repo }: GitHubRepo): string {
  const blocks: string[] = [];
  if (release.image) {
    const url = `https://github.com/${owner}/${repo}/blob/v${release.version}/${WHATS_NEW_IMAGE_DIR}/${encodeURIComponent(release.image.file)}?raw=true`;
    blocks.push(`![${release.image.alt ?? ''}](${url})`);
  }
  if (release.intro) blocks.push(release.intro);
  for (const section of release.sections) {
    blocks.push(`## ${section.heading}`);
    blocks.push(section.items.map((item) => `- **${item.lead}**${item.detail ? ` ${item.detail}` : ''}`).join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}
