import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import { enter, flush, leave } from './recorder.mjs';

vi.mock('../../../src/main/launchers/steam/adapter', async (importOriginal) =>
  (await import('./recorder.mjs')).wrapAdapter(await importOriginal(), 'SteamAdapter'),
);
vi.mock('../../../src/main/launchers/epic/adapter', async (importOriginal) =>
  (await import('./recorder.mjs')).wrapAdapter(await importOriginal(), 'EpicAdapter'),
);
vi.mock('../../../src/main/launchers/battlenet/adapter', async (importOriginal) =>
  (await import('./recorder.mjs')).wrapAdapter(await importOriginal(), 'BattlenetAdapter'),
);
vi.mock('../../../src/main/launchers/riot/adapter', async (importOriginal) =>
  (await import('./recorder.mjs')).wrapAdapter(await importOriginal(), 'RiotAdapter'),
);

const testPath = expect.getState().testPath;

beforeEach(({ task }) => enter(task));
afterEach(() => leave());
afterAll(() => flush(testPath));
