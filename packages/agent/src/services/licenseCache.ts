import * as fs from 'fs';
import * as path from 'path';

export interface LicenseEntry {
  skillIndex: number;
  licenseId: string;
  purchasedAt: number;
  expiresAt: number;
}

const DATA_DIR = path.join(__dirname, '../../data');
const FILE_PATH = path.join(DATA_DIR, 'licenses.json');

let cache: Map<string, LicenseEntry[]> | null = null;

function load(): Map<string, LicenseEntry[]> {
  if (cache) return cache;
  cache = new Map();
  try {
    if (fs.existsSync(FILE_PATH)) {
      const raw: Record<string, LicenseEntry[]> = JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
      for (const [k, v] of Object.entries(raw)) cache.set(k, v);
    }
  } catch { /* start fresh on corrupt file */ }
  return cache;
}

function persist(): void {
  const map = load();
  const obj: Record<string, LicenseEntry[]> = {};
  for (const [k, v] of map) obj[k] = v;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(obj, null, 2));
}

export function getLicenses(address: string): LicenseEntry[] {
  const now = Math.floor(Date.now() / 1000);
  return (load().get(address.toLowerCase()) ?? []).filter(
    (l) => l.expiresAt === 0 || l.expiresAt > now,
  );
}

export function addLicense(address: string, entry: LicenseEntry): void {
  const map = load();
  const key = address.toLowerCase();
  const list = map.get(key) ?? [];
  list.push(entry);
  map.set(key, list);
  persist();
}

export function hasActiveLicense(address: string, skillIndex: number): boolean {
  return getLicenses(address).some((l) => l.skillIndex === skillIndex);
}
