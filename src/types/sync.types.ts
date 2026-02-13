export type SyncSource = 'graph' | 'code' | 'initial';

export interface SyncState {
  source: SyncSource;
  inProgress: boolean;
  lastSyncTimestamp: number;
}
