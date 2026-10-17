import { Eye } from 'lucide-react';
import { useState } from 'react';
import type { WhatsNewRelease } from '@shared/whats-new';
import { WHATS_NEW } from '@shared/whats-new-releases';
import { ipc, useIpcQuery } from '../lib/ipc';
import { useUiStore } from '../store/ui';
import { Button } from './Button';
import { Dropdown } from './Dropdown';
import { Panel, Row } from './Panel';

// Under `npm run dev`, an edit to the releases file reaches the open card: the store still holds the old object, so swap in the new one.
if (import.meta.hot) {
  import.meta.hot.accept('@shared/whats-new-releases', (mod) => {
    const releases = (mod as { WHATS_NEW?: readonly WhatsNewRelease[] } | undefined)?.WHATS_NEW;
    const { whatsNew, openWhatsNew } = useUiStore.getState();
    const fresh = releases?.find((r) => r.version === whatsNew?.release.version);
    if (whatsNew && fresh) openWhatsNew({ release: fresh, version: whatsNew.version });
  });
}

/** Development builds only: opens any entry in src/shared/whats-new-releases.ts as the real card, whatever the running version. */
export default function WhatsNewDevPanel() {
  const info = useIpcQuery(() => ipc.invoke('app:info'));
  const openWhatsNew = useUiStore((s) => s.openWhatsNew);
  const [version, setVersion] = useState<string | null>(WHATS_NEW[0]?.version ?? null);
  const release = WHATS_NEW.find((r) => r.version === version) ?? null;

  return (
    <Panel title="Developer" description="Only in a development build. The packaged app carries none of this.">
      <Row
        label="Preview What's New"
        hint="Every entry in src/shared/whats-new-releases.ts, whatever the running version. Under npm run dev, saving the file updates the open card."
        align="center"
      >
        <Dropdown
          label="Release to preview"
          value={version}
          disabled={WHATS_NEW.length === 0}
          onChange={setVersion}
          options={WHATS_NEW.map((r) => ({ value: r.version, label: r.version }))}
        />
        <Button
          icon={<Eye />}
          disabled={!release || !info.data}
          onClick={() => {
            if (release && info.data) openWhatsNew({ release, version: info.data.version });
          }}
        >
          Preview
        </Button>
      </Row>
    </Panel>
  );
}
