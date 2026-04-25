const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const platformKey = `${process.platform}:${process.arch}`;
const npmCacheDir = path.join(rootDir, '.npm-cache', platformKey.replace(/[:/\\]/g, '-'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const workspaceConfigs = {
  frontend: {
    dir: path.join(rootDir, 'frontend'),
    packages: [
      {
        hostPackage: 'rolldown',
        requiredByPlatform: {
          'win32:x64': '@rolldown/binding-win32-x64-msvc',
          'win32:arm64': '@rolldown/binding-win32-arm64-msvc',
        },
        smokeTest: "import('rolldown').then(() => console.log('rolldown ok'))",
      },
      {
        hostPackage: '@swc/core',
        requiredByPlatform: {
          'win32:x64': '@swc/core-win32-x64-msvc',
          'win32:arm64': '@swc/core-win32-arm64-msvc',
        },
        smokeTest: "require('@swc/core'); console.log('@swc/core ok')",
      },
      {
        hostPackage: 'lightningcss',
        requiredByPlatform: {
          'win32:x64': 'lightningcss-win32-x64-msvc',
          'win32:arm64': 'lightningcss-win32-arm64-msvc',
        },
        smokeTest: "require('lightningcss'); console.log('lightningcss ok')",
      },
    ],
  },
  server: {
    dir: path.join(rootDir, 'server'),
    packages: [
      {
        hostPackage: '@napi-rs/canvas',
        requiredByPlatform: {
          'win32:x64': '@napi-rs/canvas-win32-x64-msvc',
          'win32:arm64': '@napi-rs/canvas-win32-arm64-msvc',
        },
        smokeTest: "require('@napi-rs/canvas'); console.log('@napi-rs/canvas ok')",
      },
    ],
  },
};

function parseTargets(argv) {
  const requested = argv.filter((arg) => !arg.startsWith('-'));
  if (argv.includes('--all') || requested.length === 0) {
    return Object.keys(workspaceConfigs);
  }

  const invalid = requested.filter((target) => !workspaceConfigs[target]);
  if (invalid.length > 0) {
    throw new Error(`Unknown workspace target(s): ${invalid.join(', ')}`);
  }

  return requested;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageDir(workspaceDir, packageName) {
  return path.join(workspaceDir, 'node_modules', ...packageName.split('/'));
}

function packageExists(workspaceDir, packageName) {
  return fs.existsSync(packageDir(workspaceDir, packageName));
}

function quoteForCmd(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@./:=+-]+$/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function runCommand(command, args, options) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const spawnArgs = needsShell
    ? ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')]
    : args;
  const spawnCommand = needsShell ? process.env.ComSpec || 'cmd.exe' : command;
  const result = spawnSync(spawnCommand, spawnArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(options?.env || {}),
    },
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function getNpmEnv() {
  fs.mkdirSync(npmCacheDir, { recursive: true });
  return {
    npm_config_cache: npmCacheDir,
  };
}

function resetNpmCache() {
  if (fs.existsSync(npmCacheDir)) {
    fs.rmSync(npmCacheDir, { recursive: true, force: true });
  }
}

function installWorkspaceDependencies(workspaceName, workspaceDir) {
  const lockFilePath = path.join(workspaceDir, 'package-lock.json');
  const installArgs = fs.existsSync(lockFilePath)
    ? ['ci', '--include=optional', '--no-audit', '--prefer-offline']
    : ['install', '--include=optional', '--no-audit', '--prefer-offline'];

  console.log(`[native] ${workspaceName}: installing workspace dependencies for ${platformKey}`);
  runCommand(npmCommand, installArgs, {
    cwd: workspaceDir,
    env: getNpmEnv(),
  });
}

function collectAlternativeNativePackages(pkg, requiredPackage) {
  return Array.from(
    new Set(
      Object.values(pkg.requiredByPlatform)
        .filter(Boolean)
        .filter((packageName) => packageName !== requiredPackage),
    ),
  );
}

function collectWorkspaceResidue(workspaceConfig, workspaceDir) {
  return workspaceConfig.packages
    .map((pkg) => {
      const requiredPackage = pkg.requiredByPlatform[platformKey];
      if (!requiredPackage) {
        return null;
      }

      const foreignPackages = collectAlternativeNativePackages(pkg, requiredPackage)
        .filter((packageName) => packageExists(workspaceDir, packageName));

      return foreignPackages.length > 0
        ? {
            hostPackage: pkg.hostPackage,
            requiredPackage,
            foreignPackages,
          }
        : null;
    })
    .filter(Boolean);
}

function rebuildWorkspaceDependencies(workspaceName, workspaceDir, residueEntries) {
  const nodeModulesDir = path.join(workspaceDir, 'node_modules');
  const residueSummary = residueEntries
    .map((entry) => `${entry.hostPackage} -> ${entry.foreignPackages.join(', ')}`)
    .join('; ');

  console.log(`[native] ${workspaceName}: detected native packages from another architecture (${residueSummary})`);
  console.log(`[native] ${workspaceName}: rebuilding node_modules for ${platformKey}`);

  if (fs.existsSync(nodeModulesDir)) {
    fs.rmSync(nodeModulesDir, { recursive: true, force: true });
  }

  resetNpmCache();

  installWorkspaceDependencies(workspaceName, workspaceDir);
}

function removePackageDirectory(workspaceDir, packageName) {
  const targetDir = packageDir(workspaceDir, packageName);
  if (!fs.existsSync(targetDir)) {
    return false;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  return true;
}

function purgeForeignNativePackages(workspaceName, workspaceDir, residueEntries) {
  const residueSummary = residueEntries
    .map((entry) => `${entry.hostPackage} -> ${entry.foreignPackages.join(', ')}`)
    .join('; ');

  console.log(`[native] ${workspaceName}: removing native packages from another architecture (${residueSummary})`);

  residueEntries.forEach((entry) => {
    entry.foreignPackages.forEach((packageName) => {
      if (removePackageDirectory(workspaceDir, packageName)) {
        console.log(`[native] ${workspaceName}: removed ${packageName}`);
      }
    });
  });
}

function findRequiredVersion(workspaceDir, hostPackageName, requiredPackageName) {
  const hostPackageJson = readJsonIfExists(path.join(packageDir(workspaceDir, hostPackageName), 'package.json'));
  if (hostPackageJson?.optionalDependencies?.[requiredPackageName]) {
    return hostPackageJson.optionalDependencies[requiredPackageName];
  }

  const lockJson = readJsonIfExists(path.join(workspaceDir, 'package-lock.json'));
  const lockEntry = lockJson?.packages?.[`node_modules/${requiredPackageName}`];
  if (lockEntry?.version) {
    return lockEntry.version;
  }

  return null;
}

function buildNativePackageSpec(packageName, version) {
  return version ? `${packageName}@${version}` : packageName;
}

function installNativePackages(workspaceName, workspaceDir, packageSpecs, reason) {
  const specs = Array.from(new Set(packageSpecs.filter(Boolean).map((item) => item.spec)));
  if (specs.length === 0) {
    return;
  }

  console.log(`[native] ${workspaceName}: ${reason} ${specs.join(', ')}`);
  runCommand(npmCommand, ['install', '--no-save', '--no-package-lock', '--no-audit', '--prefer-offline', ...specs], {
    cwd: workspaceDir,
    env: getNpmEnv(),
  });
}

function runSmokeTest(workspaceName, workspaceDir, smokeTest) {
  runCommand(process.execPath, ['-e', smokeTest], { cwd: workspaceDir });
  console.log(`[native] ${workspaceName}: native package smoke test passed`);
}

function collectRequiredNativePackages(workspaceDir, trackedPackages) {
  return trackedPackages
    .map((pkg) => {
      const packageName = pkg.requiredByPlatform[platformKey];
      if (!packageName) {
        return null;
      }

      const version = findRequiredVersion(workspaceDir, pkg.hostPackage, packageName);
      return {
        hostPackage: pkg.hostPackage,
        packageName,
        version,
        spec: buildNativePackageSpec(packageName, version),
      };
    })
    .filter(Boolean);
}

function reinstallNativePackages(workspaceName, workspaceDir, packageSpecs, packageNamesToRepair) {
  const packagesToRepair = Array.from(new Set((packageNamesToRepair || packageSpecs.map((item) => item.packageName)).filter(Boolean)));
  if (packagesToRepair.length === 0) {
    return;
  }

  console.log(`[native] ${workspaceName}: reinstalling native packages for current architecture (${packagesToRepair.join(', ')})`);
  packagesToRepair.forEach((packageName) => {
    removePackageDirectory(workspaceDir, packageName);
  });

  installNativePackages(workspaceName, workspaceDir, packageSpecs, 'installing current-architecture native packages');
}

function ensureWorkspace(workspaceName) {
  const workspaceConfig = workspaceConfigs[workspaceName];
  const workspaceDir = workspaceConfig.dir;
  let rebuiltForArchitecture = false;
  let cleanedForeignPackages = false;

  if (!fs.existsSync(path.join(workspaceDir, 'package.json'))) {
    throw new Error(`Workspace package.json not found: ${workspaceDir}`);
  }

  const trackedPackages = workspaceConfig.packages.filter((pkg) => pkg.requiredByPlatform[platformKey]);
  if (trackedPackages.length === 0) {
    console.log(`[native] ${workspaceName}: no native binding rules for ${platformKey}, skipping`);
    return;
  }
  const requiredNativePackages = collectRequiredNativePackages(workspaceDir, trackedPackages);

  const missingHostPackages = trackedPackages.filter((pkg) => !packageExists(workspaceDir, pkg.hostPackage));
  if (missingHostPackages.length > 0 || !fs.existsSync(path.join(workspaceDir, 'node_modules'))) {
    installWorkspaceDependencies(workspaceName, workspaceDir);
  }

  const residueEntries = collectWorkspaceResidue({ packages: trackedPackages }, workspaceDir);
  if (residueEntries.length > 0) {
    purgeForeignNativePackages(workspaceName, workspaceDir, residueEntries);
    cleanedForeignPackages = true;
  }

  const missingRequiredPackages = requiredNativePackages.filter((item) => !packageExists(workspaceDir, item.packageName));
  if (missingRequiredPackages.length > 0) {
    installNativePackages(workspaceName, workspaceDir, missingRequiredPackages, 'installing missing native packages');
  }

  trackedPackages.forEach((pkg) => {
    const requiredPackage = pkg.requiredByPlatform[platformKey];
    let repairedCurrentArchPackage = false;
    if (!packageExists(workspaceDir, pkg.hostPackage)) {
      throw new Error(`[native] ${workspaceName}: host package is still missing after install: ${pkg.hostPackage}`);
    }

    if (packageExists(workspaceDir, requiredPackage)) {
      console.log(`[native] ${workspaceName}: found ${requiredPackage}`);
    }

    if (!packageExists(workspaceDir, requiredPackage)) {
      throw new Error(`[native] ${workspaceName}: native package is still missing: ${requiredPackage}`);
    }

    try {
      runSmokeTest(workspaceName, workspaceDir, pkg.smokeTest);
    } catch (error) {
      let lastError = error;
      if (!repairedCurrentArchPackage) {
        try {
          reinstallNativePackages(
            workspaceName,
            workspaceDir,
            requiredNativePackages,
            requiredNativePackages.map((item) => item.packageName),
          );
          repairedCurrentArchPackage = true;
          runSmokeTest(workspaceName, workspaceDir, pkg.smokeTest);
          return;
        } catch (repairError) {
          lastError = repairError;
        }
      }

      if (!rebuiltForArchitecture) {
        const repairMode = cleanedForeignPackages ? 'after targeted native cleanup' : 'before targeted cleanup';
        console.log(`[native] ${workspaceName}: smoke test failed for ${pkg.hostPackage} ${repairMode}, rebuilding workspace dependencies once`);
        rebuildWorkspaceDependencies(
          workspaceName,
          workspaceDir,
          collectWorkspaceResidue({ packages: trackedPackages }, workspaceDir).length
            ? collectWorkspaceResidue({ packages: trackedPackages }, workspaceDir)
            : [{
                hostPackage: pkg.hostPackage,
                requiredPackage,
                foreignPackages: ['smoke-test-failed'],
              }],
        );
        rebuiltForArchitecture = true;

        const missingAfterRebuild = requiredNativePackages.filter((item) => !packageExists(workspaceDir, item.packageName));
        if (missingAfterRebuild.length > 0) {
          installNativePackages(workspaceName, workspaceDir, missingAfterRebuild, 'installing missing native packages after rebuild');
        }

        runSmokeTest(workspaceName, workspaceDir, pkg.smokeTest);
        return;
      }

      throw lastError;
    }
  });
}

function main() {
  const targets = parseTargets(process.argv.slice(2));
  console.log(`[native] checking native bindings for ${platformKey}`);
  targets.forEach(ensureWorkspace);
}

try {
  main();
} catch (error) {
  console.error(`[native] ${error.message}`);
  process.exit(1);
}
