// electron-builder: Belay.app (DMG, universal) and BelaySetup.exe (NSIS).
//
// Signing and notarization are driven by the environment only — nothing here
// names a certificate, and without the variables an unsigned local build is
// produced (`CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac`). docs/RELEASE.md
// has the owner's steps.
//
//   macOS    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID  → notarize
//            CSC_LINK / CSC_KEY_PASSWORD or a Developer ID in the keychain → sign
//   Windows  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET plus the
//            AZURE_SIGNING_* names below → Azure Trusted Signing

const env = process.env;
const notarize = Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
const azure = Boolean(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET);

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'com.gobelay.app',
  productName: 'Belay',
  directories: { output: 'release', buildResources: 'build' },
  files: ['main.js', 'host.js', 'preload.cjs', 'preload-host.cjs', 'src/**', 'renderer/**', 'build/icon.png', 'build/trayTemplate.png', 'build/trayTemplate@2x.png', 'package.json'],
  // The staged host (scripts/stage-host.mjs) sits beside the app, outside the
  // asar, because it spawns a native helper and loads node_modules by path.
  // The stage script puts the deps at host/dist/node_modules: electron-builder
  // silently drops a node_modules at the root of an extraResources tree.
  extraResources: [{ from: 'host', to: 'host' }],
  publish: { provider: 'github', owner: 'MossLouvan', repo: 'belay' },

  mac: {
    category: 'public.app-category.utilities',
    // dmg is what people download; zip is what electron-updater downloads.
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    extendInfo: {
      // Shown in the TCC consent sheets; the grant lands on Belay, not Terminal.
      NSScreenCaptureUsageDescription: 'Belay streams this screen to your phone.',
      NSAccessibilityUsageDescription: 'Belay taps and types on this Mac for your phone.',
    },
  },
  // Fixed names: gobelay.com/get links releases/latest/download/<name>.
  dmg: {
    artifactName: 'Belay-mac-universal.${ext}',
    contents: [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }],
  },

  win: {
    // One x64 installer so the fixed name is unambiguous; Windows on ARM runs it emulated.
    target: [{ target: 'nsis', arch: ['x64'] }],
    ...(azure ? {
      azureSignOptions: {
        publisherName: env.AZURE_SIGNING_PUBLISHER ?? 'CN=Belay',
        endpoint: env.AZURE_SIGNING_ENDPOINT ?? 'https://eus.codesigning.azure.net',
        certificateProfileName: env.AZURE_SIGNING_PROFILE ?? 'belay',
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT ?? 'belay',
      },
    } : {}),
  },
  nsis: { oneClick: true, perMachine: false, artifactName: 'Belay-Setup.${ext}' },
};
