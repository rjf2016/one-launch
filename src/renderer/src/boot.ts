// The first import of main.tsx: ES modules run in import order, so this executes before React and the component modules initialise.
import { markOnce, prefetchStartup } from './lib/startup';

markOnce('startup:module');

/** The startup answers, or 50 ms, whichever comes first; main.tsx renders after it. The CSS boot surface shows nothing before 250 ms, so the wait is invisible. */
export const startupReady = prefetchStartup(typeof window.oneLaunch === 'object' ? window.oneLaunch : undefined, 50);
