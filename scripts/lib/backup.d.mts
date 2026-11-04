// Types for backup.mjs (plain JavaScript so it runs on the host with no build step).

export const REPO_ROOT: string;
export const DEFAULT_BACKUP_DIR: string;
export const EXCLUDED_FROM_BACKUP: string[];

export class BackupError extends Error {}

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type ComposeOptions = {
  project?: string;
  cwd?: string;
  stdinFile?: string;
  stdoutFile?: string;
  input?: string;
};

export function assertDatabaseName(name: unknown): string;
export function compose(args: string[], options?: ComposeOptions): Promise<RunResult>;
export function liveDatabaseInfo(options?: ComposeOptions): Promise<{ user: string; database: string }>;
export function sql(statement: string, database: string, options?: ComposeOptions): Promise<string[][]>;
export function databaseExists(name: string, options?: ComposeOptions): Promise<boolean>;
export function assertSafeBackupDir(dir: string, isIgnored?: (file: string) => Promise<boolean>): Promise<string>;

export function createBackup(options?: {
  outDir?: string;
  database?: string;
  project?: string;
  prefix?: string;
  now?: Date;
}): Promise<{ path: string; bytes: number; database: string }>;

export function appIsRunning(options?: ComposeOptions): Promise<boolean>;

export function restoreBackup(options?: {
  file?: string;
  target?: string;
  replaceLive?: boolean;
  confirm?: string;
  project?: string;
  liveDatabase?: string;
  appRunning?: () => Promise<boolean>;
  now?: Date;
  reapplyGrants?: () => Promise<RunResult>;
}): Promise<{ database: string; replacedLive: boolean; previousDatabase: string }>;

export type Fingerprint = Record<string, { count: number; hash: string }>;
export function fingerprintDatabase(database: string, options?: ComposeOptions): Promise<Fingerprint>;
export function differences(a: Fingerprint, b: Fingerprint, skip?: string[]): string[];
