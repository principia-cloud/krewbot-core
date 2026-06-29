/**
 * pythonLambdaAsset — Lambda asset bundler that injects the canonical
 * `shared/python/platform_log.py` into the Lambda's source tree at
 * package time.
 *
 * Each Python Lambda imports `from platform_log import init_logger`
 * but doesn't ship that file in its source dir. This helper stages a
 * copy of the Lambda's source dir alongside `platform_log.py` into
 * `.build/python-lambdas/<hash>/`, then hands the staging dir to
 * `Code.fromAsset`. The Lambda zip ends up containing both the
 * Lambda's own files and `platform_log.py` at the root.
 *
 * Usage (core stacks):
 *     code: pythonLambdaAsset(
 *       path.join(__dirname, '..', 'lambda', 'provision'),
 *     ),
 *
 * Usage (overlay consumers):
 *     import { pythonLambdaAsset } from '@krewbot/platform-core';
 *     code: pythonLambdaAsset('./lambda/my-overlay-fn'),
 *
 * Resolves `platform_log.py` relative to this module's own location so
 * the import works identically when the package is consumed from
 * `node_modules/@krewbot/platform-core/`.
 *
 * Idempotent: a stable hash of the absolute source path makes the
 * staging dir name deterministic, so repeated synths reuse the same
 * directory and CDK's content-hashing produces stable asset hashes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// `dist/lib/python-lambda-asset.js` lives at `<package-root>/dist/lib/`,
// so the canonical file is two directories up + `shared/python/`.
const SHARED_PYTHON_DIR = path.resolve(__dirname, '..', '..', 'shared', 'python');
const STAGING_ROOT = path.join(process.cwd(), '.build', 'python-lambdas');

const SKIP_NAMES = new Set(['__pycache__', '.DS_Store', '.pytest_cache']);

function copyDirContents(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function pythonLambdaAsset(
  srcDir: string,
  options?: Parameters<typeof lambda.Code.fromAsset>[1],
): lambda.Code {
  const absSrc = path.resolve(srcDir);
  if (!fs.existsSync(absSrc)) {
    throw new Error(`pythonLambdaAsset: source directory does not exist: ${absSrc}`);
  }
  if (!fs.existsSync(SHARED_PYTHON_DIR)) {
    throw new Error(
      `pythonLambdaAsset: shared python directory missing at ${SHARED_PYTHON_DIR}. ` +
        'The @krewbot/platform-core package may have been installed without `shared/` ' +
        '— check the files allowlist in its package.json.',
    );
  }

  const hash = crypto.createHash('sha256').update(absSrc).digest('hex').slice(0, 12);
  const stagingDir = path.join(STAGING_ROOT, `${path.basename(absSrc)}-${hash}`);

  fs.rmSync(stagingDir, { recursive: true, force: true });
  copyDirContents(absSrc, stagingDir);
  copyDirContents(SHARED_PYTHON_DIR, stagingDir);

  return lambda.Code.fromAsset(stagingDir, options);
}
