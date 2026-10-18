// Renders a release's GitHub notes from its What's New entry (src/shared/whats-new-releases.ts), the same text the card shows.
//   npm run release:notes -- [v<version>] [--out=<path>]      (the version defaults to package.json's)
// The release workflow writes the file and hands it to gh release create; without --out the Markdown is printed.
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { renderWhatsNewMarkdown } from '../src/shared/whats-new-markdown.ts';
import { WHATS_NEW } from '../src/shared/whats-new-releases.ts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const unknown = args.find((a) => a.startsWith('--') && !a.startsWith('--out='));
if (unknown) fail(`Unknown option ${unknown}. Usage: npm run release:notes -- [v<version>] [--out=<path>]`);
const out = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const requested = args.find((a) => !a.startsWith('--'));

const root = new URL('../', import.meta.url);
const version = requested ? requested.replace(/^v/, '') : JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
const publish = yaml.load(readFileSync(new URL('electron-builder.yml', root), 'utf8'))?.publish;
if (typeof publish?.owner !== 'string' || typeof publish?.repo !== 'string') fail('electron-builder.yml names no publish owner and repo.');

const release = WHATS_NEW.find((r) => r.version === version);
if (!release) {
  fail(
    `No What's New entry for ${version} in src/shared/whats-new-releases.ts. The entry is the release's notes; add it before tagging (docs/development.md, "Releases").`,
  );
}

const markdown = renderWhatsNewMarkdown(release, publish);
if (out) writeFileSync(out, markdown);
else process.stdout.write(markdown);
