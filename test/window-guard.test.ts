import { describe, expect, it } from 'vitest';
import { closeRequestAction, isTrustedRendererUrl, placementFrom } from '../src/main/window-guard';

describe('closeRequestAction', () => {
  it('hides to the tray when the setting is on, even during a switch', () => {
    expect(closeRequestAction({ quitting: false, closeToTray: true, switchBusy: false })).toBe('hide');
    expect(closeRequestAction({ quitting: false, closeToTray: true, switchBusy: true })).toBe('hide');
  });

  it('with the tray off, closes when idle and asks during a switch', () => {
    expect(closeRequestAction({ quitting: false, closeToTray: false, switchBusy: false })).toBe('close');
    expect(closeRequestAction({ quitting: false, closeToTray: false, switchBusy: true })).toBe('ask');
  });

  it('a quit already under way closes whatever the setting says', () => {
    expect(closeRequestAction({ quitting: true, closeToTray: true, switchBusy: true })).toBe('close');
    expect(closeRequestAction({ quitting: true, closeToTray: false, switchBusy: false })).toBe('close');
  });
});

const PAGE = 'file:///C:/Program%20Files/One%20Launch/resources/app.asar/out/renderer/index.html';
const packaged = { rendererFileUrl: PAGE, devUrl: null };
const dev = { rendererFileUrl: PAGE, devUrl: 'http://localhost:5173' };

describe('isTrustedRendererUrl (B19)', () => {
  it('accepts only the packaged page itself, with or without a hash or query', () => {
    for (const url of [PAGE, `${PAGE}#/settings`, `${PAGE}?v=1`]) expect(isTrustedRendererUrl(url, packaged), url).toBe(true);
    for (const url of [
      undefined,
      '',
      `${PAGE}.evil.html`,
      `${PAGE}/../other.html`,
      'file:///C:/Users/someone/Downloads/index.html',
      'https://example.com/',
      'http://localhost:5173/',
      'onelaunch-art://game/1/grid.png',
      'about:blank',
    ]) {
      expect(isTrustedRendererUrl(url, packaged), String(url)).toBe(false);
    }
  });

  it('in development accepts the dev server origin, not an address that only starts like it', () => {
    for (const url of ['http://localhost:5173', 'http://localhost:5173/', 'http://localhost:5173/index.html#/library']) {
      expect(isTrustedRendererUrl(url, dev), url).toBe(true);
    }
    for (const url of [
      'http://localhost:51731/',
      'http://localhost:5173.evil.test/',
      'https://localhost:5173/',
      'http://127.0.0.1:5173/',
      PAGE,
      'not a url',
      undefined,
    ]) {
      expect(isTrustedRendererUrl(url, dev), String(url)).toBe(false);
    }
  });
});

describe('placementFrom (B19)', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  const stored = (v: object): string => JSON.stringify(v);

  it('restores a placement that is on a connected display, never smaller than the minimum window', () => {
    expect(placementFrom(stored({ x: 100, y: 80, width: 1400, height: 900, maximized: false }), [primary])).toEqual({
      bounds: { x: 100, y: 80, width: 1400, height: 900 },
      maximized: false,
    });
    expect(placementFrom(stored({ x: 100, y: 80, width: 300, height: 200 }), [primary]).bounds).toEqual({ x: 100, y: 80, width: 960, height: 600 });
    expect(placementFrom(stored({ x: -1800, y: 40, width: 1280, height: 800, maximized: true }), [primary, left])).toEqual({
      bounds: { x: -1800, y: 40, width: 1280, height: 800 },
      maximized: true,
    });
  });

  it('drops a placement whose title bar could not be reached, but still remembers maximized', () => {
    const gone = stored({ x: -1800, y: 40, width: 1280, height: 800, maximized: true });
    expect(placementFrom(gone, [primary])).toEqual({ bounds: null, maximized: true });
    expect(placementFrom(stored({ x: 1900, y: 40, width: 1280, height: 800 }), [primary]).bounds).toBeNull();
    expect(placementFrom(stored({ x: 100, y: -200, width: 1280, height: 800 }), [primary]).bounds).toBeNull();
    expect(placementFrom(stored({ x: 100, y: 1030, width: 1280, height: 800 }), [primary]).bounds).toBeNull();
    expect(placementFrom(stored({ x: 100, y: 80, width: 1280, height: 800 }), []).bounds).toBeNull();
  });

  it('treats a missing, malformed, or non-numeric setting as no placement', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      '"x"',
      stored({ x: '1', y: 2, width: 3, height: 4 }),
      stored({ x: 1, y: 2, width: null, height: 4 }),
      '{"x":1e999,"y":2,"width":1280,"height":800}',
    ]) {
      expect(placementFrom(raw, [primary]), String(raw)).toEqual({ bounds: null, maximized: false });
    }
  });
});
