#!/usr/bin/env node
/**
 * Build script for Trimly extension
 * Bundles TypeScript → single JS files (no imports) for MV3 compatibility
 *
 * Usage:
 *   node build.cjs                     - Development build for Firefox (default)
 *   node build.cjs --target=firefox    - Build for Firefox
 *   node build.cjs --target=chrome     - Build for Chrome
 *   node build.cjs --watch             - Watch mode for development
 *   node build.cjs --production        - Production build (minified, no sourcemaps)
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

// Parse --target=firefox|chrome (default: firefox)
const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : 'firefox';
const validTargets = ['firefox', 'chrome'];
if (!validTargets.includes(target)) {
  console.error(`❌ Invalid target: ${target}. Use: ${validTargets.join(', ')}`);
  process.exit(1);
}

/**
 * Read project metadata from package.json (single source of truth).
 */
function getProjectMetadata() {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = packageJson.version;
  const description = packageJson.description;

  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Invalid "version" in package.json');
  }

  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('Invalid "description" in package.json');
  }

  return {
    version: version.trim(),
    description: description.trim(),
  };
}

/**
 * Sync manifest metadata from package.json so extension metadata is centralized.
 */
function syncManifestVersions() {
  const { version, description } = getProjectMetadata();
  const manifestFiles = [
    'extension/manifest.firefox.json',
    'extension/manifest.chrome.json',
  ];

  for (const manifestPath of manifestFiles) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let changed = false;
    if (manifest.version !== version) {
      manifest.version = version;
      changed = true;
    }
    if (manifest.description !== description) {
      manifest.description = description;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
  }
}

/**
 * Copy manifest for target browser
 */
function copyManifest() {
  const manifestSrc = `extension/manifest.${target}.json`;
  const manifestDest = 'extension/manifest.json';

  // Always remove existing manifest.json first
  if (fs.existsSync(manifestDest)) {
    fs.unlinkSync(manifestDest);
  }

  if (target === 'chrome') {
    // For Chrome, copy manifest.chrome.json
    fs.copyFileSync(manifestSrc, manifestDest);
  } else {
    // For Firefox, prefer symlink (dev-friendly), but fall back to copy on Windows
    // where non-admin users often cannot create symlinks (EPERM).
    try {
      fs.symlinkSync('manifest.firefox.json', manifestDest);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EINVAL')) {
        fs.copyFileSync(manifestSrc, manifestDest);
        return;
      }
      throw error;
    }
  }
}

/**
 * Copy static files from src to extension folder
 */
function copyStaticFiles() {
  const filesToCopy = [
    { src: 'extension/src/popup/popup.html', dest: 'extension/popup/popup.html' },
    { src: 'extension/src/popup/popup.css', dest: 'extension/popup/popup.css' },
  ];

  for (const { src, dest } of filesToCopy) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Create or remove .dev marker file for development mode detection.
 * The popup checks for this file to show/hide debug options.
 */
function handleDevMarker() {
  const devMarkerPath = 'extension/.dev';

  if (isProduction) {
    // Remove .dev marker in production
    if (fs.existsSync(devMarkerPath)) {
      fs.unlinkSync(devMarkerPath);
    }
  } else {
    // Create .dev marker in development
    fs.writeFileSync(devMarkerPath, 'Development build marker\n');
  }
}

const buildOptions = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  // Production: minify and no sourcemaps
  // Development: no minification, with sourcemaps for debugging
  minify: isProduction,
  sourcemap: !isProduction,
  // Drop console.log and debugger in production for smaller bundle
  drop: isProduction ? ['debugger'] : [],
  // Define build mode for conditional code
  define: {
    'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
    __LS_IS_PROD__: JSON.stringify(isProduction),
  },
};

async function build() {
  const mode = isProduction ? 'production' : 'development';
  const targetLabel = target.charAt(0).toUpperCase() + target.slice(1);
  console.log(`🔧 Build: ${targetLabel} (${mode})`);

  try {
    await esbuild.build({
      ...buildOptions,
      entryPoints: ['extension/src/background/background.ts'],
      outfile: 'extension/dist/background.js',
    });

    await esbuild.build({
      ...buildOptions,
      entryPoints: ['extension/src/page/page-script.ts'],
      outfile: 'extension/dist/page-script.js',
    });

    await esbuild.build({
      ...buildOptions,
      entryPoints: ['extension/src/content/page-inject.ts'],
      outfile: 'extension/dist/page-inject.js',
    });

    await esbuild.build({
      ...buildOptions,
      entryPoints: ['extension/src/content/content.ts'],
      outfile: 'extension/dist/content.js',
    });

    await esbuild.build({
      ...buildOptions,
      entryPoints: ['extension/src/popup/popup.ts'],
      outfile: 'extension/popup/popup.js',
    });

    syncManifestVersions();
    copyStaticFiles();
    copyManifest();
    handleDevMarker();

    console.log(`✅ Build complete: ${targetLabel}`);
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

async function watch() {
  console.log(`👀 Watch mode enabled for ${target.toUpperCase()}. Watching for changes...\n`);

  const contexts = await Promise.all([
    esbuild.context({
      ...buildOptions,
      entryPoints: ['extension/src/background/background.ts'],
      outfile: 'extension/dist/background.js',
    }),
    esbuild.context({
      ...buildOptions,
      entryPoints: ['extension/src/page/page-script.ts'],
      outfile: 'extension/dist/page-script.js',
    }),
    esbuild.context({
      ...buildOptions,
      entryPoints: ['extension/src/content/page-inject.ts'],
      outfile: 'extension/dist/page-inject.js',
    }),
    esbuild.context({
      ...buildOptions,
      entryPoints: ['extension/src/content/content.ts'],
      outfile: 'extension/dist/content.js',
    }),
    esbuild.context({
      ...buildOptions,
      entryPoints: ['extension/src/popup/popup.ts'],
      outfile: 'extension/popup/popup.js',
    }),
  ]);

  // Initial build
  for (const ctx of contexts) {
    await ctx.rebuild();
  }
  syncManifestVersions();
  copyStaticFiles();
  copyManifest();
  handleDevMarker();
  console.log(`✅ Initial build complete for ${target.toUpperCase()}.\n`);

  // Start watching
  for (const ctx of contexts) {
    await ctx.watch();
  }

  // Watch static files manually
  const staticFiles = [
    'extension/src/popup/popup.html',
    'extension/src/popup/popup.css',
  ];
  for (const file of staticFiles) {
    fs.watchFile(file, { interval: 500 }, () => {
      console.log(`📄 ${path.basename(file)} changed`);
      copyStaticFiles();
    });
  }

  console.log('Watching for changes... (Ctrl+C to stop)\n');
}

if (isWatch) {
  watch();
} else {
  build();
}
