// One-time setup for on-PC speech-to-text: downloads a prebuilt whisper.cpp
// binary (Windows) and the ggml-base.en model (~142 MB) into server/whisper/.
// On macOS/Linux, install whisper-cpp with your package manager (e.g.
// `brew install whisper-cpp`) and this script will just fetch the model.
//
// Usage: npm run setup:whisper   [TETHER_WHISPER_MODEL_NAME=base.en]

import { mkdirSync, writeFileSync, existsSync, readdirSync, copyFileSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'whisper');
const MODEL = process.env.TETHER_WHISPER_MODEL_NAME || 'base.en';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin`;

mkdirSync(DIR, { recursive: true });

async function download(url, dest, label) {
  console.log(`  downloading ${label}...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`  saved ${dest}`);
}

async function setupWindowsBinary() {
  if (existsSync(join(DIR, 'whisper-cli.exe')) || existsSync(join(DIR, 'main.exe'))) {
    console.log('  whisper binary already present, skipping');
    return;
  }
  console.log('  looking up latest whisper.cpp release...');
  const rel = await (await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', {
    headers: { 'User-Agent': 'tether-setup' },
  })).json();
  const asset = (rel.assets || []).find((a) => /win/i.test(a.name) && /x64/i.test(a.name) && a.name.endsWith('.zip'))
    || (rel.assets || []).find((a) => /bin.*x64/i.test(a.name) && a.name.endsWith('.zip'));
  if (!asset) {
    throw new Error(
      'could not find a Windows x64 zip in the latest whisper.cpp release.\n' +
      '  Download one manually from https://github.com/ggml-org/whisper.cpp/releases\n' +
      `  and unzip whisper-cli.exe (plus its DLLs) into ${DIR}`,
    );
  }
  const zip = join(DIR, asset.name);
  await download(asset.browser_download_url, zip, asset.name);
  console.log('  extracting...');
  const extractDir = join(DIR, '_extract');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extractDir}' -Force`]);
  // Flatten: pull whisper-cli.exe/main.exe and every DLL up into DIR.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const f of walk(extractDir)) {
    const name = f.split(/[\\/]/).pop();
    if (/^(whisper-cli|main)\.exe$/i.test(name) || /\.dll$/i.test(name)) {
      copyFileSync(f, join(DIR, name));
    }
  }
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zip, { force: true });
  if (!existsSync(join(DIR, 'whisper-cli.exe')) && !existsSync(join(DIR, 'main.exe'))) {
    throw new Error(`extraction finished but no whisper-cli.exe found — check ${DIR} by hand`);
  }
  console.log('  binary ready');
}

try {
  console.log('Setting up whisper.cpp for Tether voice input');
  if (process.platform === 'win32') {
    await setupWindowsBinary();
  } else {
    console.log('  non-Windows: install the binary yourself (e.g. `brew install whisper-cpp`),');
    console.log('  then set TETHER_WHISPER_CLI to its path if it is not in server/whisper/.');
  }
  const modelPath = join(DIR, `ggml-${MODEL}.bin`);
  if (existsSync(modelPath)) {
    console.log('  model already present, skipping');
  } else {
    await download(MODEL_URL, modelPath, `ggml-${MODEL}.bin (~142 MB for base.en)`);
  }
  writeFileSync(join(DIR, '.gitignore'), '*\n');
  console.log('Done. Restart the host agent and the mic button on the phone will light up.');
} catch (e) {
  console.error('\nSetup failed:', e.message);
  process.exit(1);
}
