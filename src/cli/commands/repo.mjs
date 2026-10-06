import { addRepoAlias, loadMachineConfig } from '../../config.mjs';
import { requirePositionals, usageError } from '../util.mjs';

export const repoAdd = {
  usage: 'repo add <alias> <path> [--node-modules junction|none]',
  options: { 'node-modules': { type: 'string' } },
  run(c) {
    requirePositionals(c, 2);
    const [alias, repoPath] = c.positionals;
    let config;
    try {
      config = addRepoAlias(c.home, alias, repoPath, { nodeModules: c.values['node-modules'] ?? 'none' });
    } catch (err) {
      throw usageError(err.message);
    }
    const repo = config.repos[alias];
    return {
      data: { alias, path: repo.path, prepare: repo.prepare },
      text: `repo ${alias} -> ${repo.path} (node_modules: ${repo.prepare.node_modules})`,
    };
  },
};

export const repoList = {
  usage: 'repo list',
  options: {},
  run(c) {
    requirePositionals(c, 0);
    const repos = loadMachineConfig(c.home).repos;
    const aliases = Object.keys(repos).sort();
    return {
      data: { repos },
      text: aliases.length
        ? aliases.map((a) => `${a}  ${repos[a].path}  node_modules=${repos[a].prepare.node_modules}`).join('\n')
        : '(no repos; add one with: hybrid repo add <alias> <path>)',
    };
  },
};
