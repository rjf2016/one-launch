// The entry. Node's compile cache keeps V8's compiled form of the main bundle and better-sqlite3's modules between starts, so a warm
// start skips their parse; it has to be switched on before the bundle is imported, which is all this module does. The cache lives in
// the temp folder because the data folder is only known once index.ts has read the command line.
import { enableCompileCache } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';

enableCompileCache(join(app.getPath('temp'), 'one-launch-compile-cache'));
await import('./index');
