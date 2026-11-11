import { MANIFEST, TOOLING_BRANCH, buildManifest, toolingState } from './lib/bundle.mjs';
import { resolveOut, writeArtefact } from './lib/out.mjs';

function main(argv) {
  const out = resolveOut(argv);
  const tooling = toolingState();
  if (tooling.branch !== TOOLING_BRANCH) {
    console.error(`The manifest is written from ${TOOLING_BRANCH}; this checkout is on ${tooling.branch}.`);
    return 1;
  }
  if (tooling.dirty && !argv.includes('--allow-dirty')) {
    console.error('The tooling tree has uncommitted changes. Commit them first; --allow-dirty writes a manifest that verify accepts only with the same flag.');
    return 1;
  }
  const manifest = buildManifest(out, tooling);
  writeArtefact(out, MANIFEST, manifest);
  const dirty = tooling.dirty ? ' (uncommitted)' : '';
  console.log(
    `${MANIFEST}: ${Object.keys(manifest.files).length} files, pin ${manifest.pin.commit.slice(0, 7)}, tooling ${tooling.commit.slice(0, 7)}${dirty}`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
