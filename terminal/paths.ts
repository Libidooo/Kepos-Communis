import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
// Legacy environment overrides remain explicit opt-ins; clean installs use Kepos's own home.
export const root=resolve(process.env.ORBITAL_HOME||join(process.env.KEPOS_DATA_DIR||process.env.ORBITAL_DATA_DIR||join(process.env.KEPOS_HOME||join(homedir(),'.kepos'),'data'),'orbital'));
export const dataRoot=dirname(root);
export const sessionRoot=join(dataRoot,'sessions');
export const databasePath=join(dataRoot,'orbital.sqlite');
