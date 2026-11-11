import '../../lib/clock.setup.mjs';
import { defineReplay } from '../harness/define';

// The simulated updater reports its end 20 ms before the sign-in, and the adapter looks every 100 ms.
defineReplay('self-update', { transient: [{ step: 'verify', status: 'running', detail: 'Steam finished updating itself.' }] });
