// Which encrypted backups to keep. Plain JavaScript with no imports, so the server
// (Node 22, no node_modules) and the PC can both run it.
//
// Keep: everything from the last 48 hours; the newest backup of each of the 7 most
// recent days that have one; the newest of each of the 4 most recent ISO weeks that
// have one. A name that is not a finished backup is never deleted.

const NAME = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.age$/;
const HOUR = 3_600_000;
const RECENT_HOURS = 48;
const DAILY = 7;
const WEEKLY = 4;

/** The UTC time in a backup's name, or null if this is not a finished backup. */
export function parseBackupName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject impossible dates (Date.UTC would roll 2026-13-99 into a later month).
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return date;
}

const dayKey = (date) => date.toISOString().slice(0, 10);

/** The Monday (UTC) of the ISO week this date falls in. */
function weekKey(date) {
  const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000);
  return dayKey(monday);
}

/** The newest backup in each group, for the `limit` most recent groups. */
function newestPerGroup(backups, keyOf, limit) {
  const newest = new Map();
  for (const b of backups) {
    const key = keyOf(b.date);
    if (!newest.has(key) || newest.get(key).date < b.date) newest.set(key, b);
  }
  return [...newest.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, limit)
    .map(([, b]) => b.name);
}

/** Names to delete under the retention rule, oldest first. */
export function backupsToDelete(names, now) {
  const backups = names
    .map((name) => ({ name, date: parseBackupName(name) }))
    .filter((b) => b.date !== null);
  const keep = new Set([
    ...backups.filter((b) => now.getTime() - b.date.getTime() < RECENT_HOURS * HOUR).map((b) => b.name),
    ...newestPerGroup(backups, dayKey, DAILY),
    ...newestPerGroup(backups, weekKey, WEEKLY),
  ]);
  return backups
    .filter((b) => !keep.has(b.name))
    .sort((a, b) => a.date - b.date)
    .map((b) => b.name);
}

/** Hours since the newest recognised backup, or null when there is none. */
export function newestBackupAgeHours(names, now) {
  const dates = names.map(parseBackupName).filter((d) => d !== null);
  if (dates.length === 0) return null;
  const newest = Math.max(...dates.map((d) => d.getTime()));
  return (now.getTime() - newest) / HOUR;
}
