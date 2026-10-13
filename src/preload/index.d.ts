import type { OneLaunchApi } from '../shared/ipc-contract';

declare global {
  interface Window {
    oneLaunch: OneLaunchApi;
  }
}

export {};
