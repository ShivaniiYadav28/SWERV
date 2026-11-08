import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this file so the backend always loads backend/.env,
// whether it starts from the backend folder or the workspace root.
const envFilePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
dotenv.config({ path: envFilePath });
