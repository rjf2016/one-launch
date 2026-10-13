import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FAKE_REPORT_FILE = 'fake-platform.json';

export interface FakeReportData {
  registryWrites: { op: 'set' | 'delete'; path: string; value?: string | number }[];
  processEvents: { kind: 'start' | 'close' | 'kill'; exe: string; args: string[] }[];
  opened: string[];
  fetched: string[];
  clipboardWrites: number;
  /** `<product>.<patchline>` per launch request One Launch sent the fake Riot Client's local server (its Play). */
  riotLaunchRequests: string[];
}

/**
 * Everything the fake platform was asked to do to the machine, rewritten to <dataDir>\fake-platform.json
 * on every change so it survives a hard kill. Scenarios read it to prove what a switch did and did not touch.
 */
export class FakeReport {
  readonly data: FakeReportData = { registryWrites: [], processEvents: [], opened: [], fetched: [], clipboardWrites: 0, riotLaunchRequests: [] };
  private file: string | null = null;

  attach(dataDir: string): void {
    this.file = join(dataDir, FAKE_REPORT_FILE);
    this.flush();
  }

  registryWrite(entry: FakeReportData['registryWrites'][number]): void {
    this.data.registryWrites.push(entry);
    this.flush();
  }

  processEvent(entry: FakeReportData['processEvents'][number]): void {
    this.data.processEvents.push(entry);
    this.flush();
  }

  opened(url: string): void {
    this.data.opened.push(url);
    this.flush();
  }

  fetched(url: string): void {
    this.data.fetched.push(url);
    this.flush();
  }

  clipboardWrite(): void {
    this.data.clipboardWrites++;
    this.flush();
  }

  riotLaunchRequest(id: string): void {
    this.data.riotLaunchRequests.push(id);
    this.flush();
  }

  private flush(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
