import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { githubUrl } from './repository-url.mjs';
import { assertRegular, CONFIG_KEY, LEGACY_CONFIG_KEYS, packageInfo, packageConfig, readPackage, validateConfig, writePackage } from './config.mjs';

export function init(root, options = {}) {
  const packageFile = path.join(root, 'package.json');
  const ignoreFile = path.join(root, '.gitignore');
  [packageFile, ignoreFile].forEach(assertRegular);
  const { pkg, text } = existsSync(packageFile) ? readPackage(root) : { pkg: { name: 'my-portal-gas-workspace', private: true }, text: '' };
  for (const key of ['scripts', 'dependencies', 'devDependencies']) {
    if (pkg[key] !== undefined && (!pkg[key] || typeof pkg[key] !== 'object' || Array.isArray(pkg[key]))) throw new Error(`${key} in package.json must be an object.`);
  }
  // Keep an existing configuration; otherwise create it from the options.
  pkg[CONFIG_KEY] = validateConfig(packageConfig(pkg) ?? {
    ...(options.scriptId !== undefined ? { scriptId: options.scriptId } : {}),
    ...(options.deploymentId !== undefined ? { deploymentId: options.deploymentId } : {}),
    ...(options.authProfile !== undefined ? { authProfile: options.authProfile } : {}),
  });
  for (const key of LEGACY_CONFIG_KEYS) delete pkg[key];
  pkg.scripts ??= {};
  const scripts = { build: 'portal build', preview: 'portal preview', browse: 'portal browse', push: 'portal push', deploy: 'portal deploy', ship: 'npm run push && npm run deploy', login: 'portal login' };
  for (const [name, command] of Object.entries(scripts)) pkg.scripts[name] ??= command;
  for (const key of LEGACY_CONFIG_KEYS) {
    if (pkg.dependencies?.[key] || pkg.devDependencies?.[key]) throw new Error(`Replace the ${key} dependency with my-portal-gas before running portal init.`);
  }
  if (!pkg.dependencies?.['my-portal-gas'] && !pkg.devDependencies?.['my-portal-gas']) {
    pkg.devDependencies ??= {};
    const repository = githubUrl(packageInfo.repository.url);
    if (!repository) throw new Error('The package source GitHub repository is not configured.');
    pkg.devDependencies['my-portal-gas'] = `${repository}/releases/download/v${packageInfo.version}/my-portal-gas-${packageInfo.version}.tgz`;
  }
  const ignore = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
  const lines = new Set(ignore.split(/\r?\n/).map((line) => line.trim()));
  // Append exclusions last so existing negation patterns cannot expose output or credentials.
  const block = 'node_modules/\n.portal/\n.clasprc.json\nclient_secret*.json\n';
  const hasFinalBlock = ignore.endsWith(block);
  const nextIgnore = hasFinalBlock ? ignore : ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '\n# my-portal-gas: generated files and local credentials\n' + block;
  writePackage(packageFile, pkg, text);
  if (!hasFinalBlock || !lines.has('.portal/')) writeFileSync(ignoreFile, nextIgnore);
  return pkg[CONFIG_KEY];
}
