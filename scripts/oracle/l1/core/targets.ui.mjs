import { IPC_CHANNELS } from './ipc/channels.mjs';

const v = (name) => `l1/core/${name}.json`;
const PHASES = 'src/renderer/src/lib/phases.ts';

export default [
  {
    item: 'Bad-payload matrix per channel, giving the envelope',
    exports: IPC_CHANNELS.map((channel) => ({
      export: 'registerIpcHandlers',
      source: 'src/main/ipc/index.ts',
      vector: v(`ipc.${channel.replace(':', '-')}`),
    })),
  },
  {
    item: 'lib/phases.ts',
    exports: ['phaseOf', 'phaseLabel', 'groupSteps', 'sentence', 'stoppedNote', 'jobAnnouncement', 'planPhases'].map((name) => ({
      export: name,
      source: PHASES,
      vector: v(`renderer.phases.${name}`),
    })),
  },
  {
    item: 'lib/recovery.ts',
    exports: [{ export: 'recoveryCopy', source: 'src/renderer/src/lib/recovery.ts', vector: v('renderer.recovery.recoveryCopy') }],
  },
  {
    item: 'lib/time.ts',
    exports: ['formatRelative', 'formatDateTime'].map((name) => ({ export: name, source: 'src/renderer/src/lib/time.ts', vector: v(`renderer.time.${name}`) })),
  },
  {
    item: 'sort comparators',
    exports: [
      { export: 'sortAccounts', source: 'src/renderer/src/views/AccountsView.tsx', vector: v('renderer.sort.sortAccounts') },
      { export: 'lastPlayedOf', source: 'src/renderer/src/components/GameCard.tsx', vector: v('renderer.sort.lastPlayedOf') },
    ],
  },
];
