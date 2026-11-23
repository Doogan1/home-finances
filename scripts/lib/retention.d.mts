// Types for retention.mjs (plain JavaScript so it runs on the server with no build step).
export function parseBackupName(name: string): Date | null;
export function backupsToDelete(names: string[], now: Date): string[];
export function newestBackupAgeHours(names: string[], now: Date): number | null;
