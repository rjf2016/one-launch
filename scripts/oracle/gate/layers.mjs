import { AREAS as VECTOR_AREAS } from '../l1/lib/grammar.mjs';
import { AREAS as SHOT_AREAS } from '../ui/rows.mjs';

const GENERATE = 'scripts/oracle/generate.mjs';

export const SEEDS = ['PIN', 'SCREENSHOTS.md', 'fixtures'];

export const LAYERS = [
  {
    name: 'schemas',
    covers: /^schemas\//,
    steps: [{ label: 'schemas', script: 'scripts/oracle/emit-schemas.mjs' }],
  },
  {
    name: 'vectors',
    covers: /^l1\//,
    steps: [
      { label: 'vectors', script: GENERATE, args: ['l1'] },
      ...VECTOR_AREAS.map((area) => ({ label: `coverage of ${area}`, script: 'scripts/oracle/l1/coverage/run.mjs', args: [area] })),
    ],
  },
  {
    name: 'tests',
    covers: /^tests\//,
    steps: [{ label: 'test catalogue and goldens', script: 'scripts/oracle/tests/capture.mjs' }],
  },
  {
    name: 'replay',
    covers: /^l2\/(?!updates\/)/,
    steps: [
      { label: 'replays', script: GENERATE, args: ['l2'] },
      { label: 'five replays through Electron', script: 'scripts/oracle/l2/cross-check.mjs', args: ['--no-build'], app: true },
    ],
  },
  {
    name: 'updates',
    covers: /^l2\/updates\//,
    steps: [{ label: 'update transcripts', script: 'scripts/oracle/updates/capture.mjs', scratch: 't06', app: true }],
  },
  {
    name: 'ui',
    covers: /^ui\/(?!owner\/)/,
    // A repeat record is the verdict of an earlier comparison, so the status file is built on the bundle's.
    seeds: ['ui/repeat'],
    steps: [
      ...Object.keys(SHOT_AREAS).map((area) => ({ label: `shots of ${area}`, script: 'scripts/oracle/ui/capture.mjs', args: [area, '--no-build'], app: true })),
      { label: 'status of every row', script: 'scripts/oracle/ui/status.mjs' },
    ],
  },
  {
    name: 'native',
    covers: /^ui\/owner\//,
    steps: [{ label: 'native windows', script: 'scripts/oracle/ui/native/capture.mjs', scratch: 't09', app: true }],
  },
  {
    name: 'assets',
    covers: /^assets\//,
    steps: [
      { label: 'tray, tokens and states from the app', script: 'scripts/oracle/assets/capture.mjs', scratch: 't08', app: true },
      // The copy map quotes every text run, the volatile ones too, so it repeats only from the sidecars it was built from.
      { label: 'copy, styles, icons', script: GENERATE, args: ['assets'], from: ['ui/shots', 'l2/expected'] },
    ],
  },
  {
    name: 'takeover',
    covers: /^takeover\//,
    steps: [{ label: 'takeover generators', script: GENERATE, args: ['takeover'] }],
  },
];

export const NOT_CAPTURED = [
  [/^fixtures\//, 'seeded input, hashed in the manifest'],
  [/^(PIN|SCREENSHOTS\.md)$/, 'seeded input, hashed in the manifest'],
  [/^MANIFEST\.json$/, 'written by manifest.mjs'],
  [/^perf\//, 'measured timings, which do not repeat'],
  [/^ui\/repeat\//, 'the verdicts of the earlier repeat captures'],
  [/^takeover\/(contract\.md|README\.md|vault\/LAYOUT\.md|nsis\/README\.md)$/, 'written by hand and measured by takeover/check.mjs'],
];

export const layerOf = (path) => LAYERS.find((layer) => layer.covers.test(path))?.name ?? null;
