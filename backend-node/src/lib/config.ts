import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const BACKEND_NODE_ROOT = join(here, '..', '..');
export const PROJECT_ROOT = join(here, '..', '..', '..');
export const STORAGE_DIR = process.env.STORAGE_DIR ?? join(BACKEND_NODE_ROOT, 'storage');
