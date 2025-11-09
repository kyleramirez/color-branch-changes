import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const usage = 'Usage: pnpm host:<code|cursor> <path/to/project>';
const validApplications = new Set(['code', 'cursor']);
const [application, target] = process.argv.slice(2);

if (!application || !validApplications.has(application)) {
  console.error('Error: application must be "code" or "cursor".');
  console.error(usage);
  process.exit(1);
}

if (!target) {
  console.error('Error: A target directory is required.');
  console.error(usage);
  process.exit(1);
}

const targetDir = resolve(target);

if (!existsSync(targetDir)) {
  console.error(`Error: Target directory "${targetDir}" does not exist.`);
  process.exit(1);
}

const extensionPath = process.cwd();
const args = [`--extensionDevelopmentPath=${extensionPath}`, targetDir];

try {
  console.log(`Executing: ${application} ${args.join(' ')}`);
  execFileSync(application, args, { stdio: 'inherit' });
} catch (error) {
  const message =
    error instanceof Error && 'message' in error ? error.message : String(error);
  console.error(`${application} command failed: ${message}`);
  process.exit(typeof error === 'object' && error && 'status' in error ? error.status ?? 1 : 1);
}
