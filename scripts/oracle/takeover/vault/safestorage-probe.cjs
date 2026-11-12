const { readFileSync, writeFileSync } = require('node:fs');
const { app, safeStorage } = require('electron');

const [mode, profile, ioFile] = process.argv.slice(-3);
app.setPath('userData', profile);

app.whenReady().then(() => {
  const io = JSON.parse(readFileSync(ioFile, 'utf8'));
  let result;
  if (mode === 'encrypt') {
    result = { available: safeStorage.isEncryptionAvailable(), blobs: io.plaintexts.map((p) => safeStorage.encryptString(p).toString('base64')) };
  } else {
    result = {
      available: safeStorage.isEncryptionAvailable(),
      results: io.blobs.map((b) => {
        try {
          return { ok: true, plaintext: safeStorage.decryptString(Buffer.from(b, 'base64')) };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      }),
    };
  }
  writeFileSync(io.out, JSON.stringify(result));
  app.quit();
});
