// React Native's own fetch, not expo/fetch. From SDK 57 Expo replaces the
// global fetch with expo/fetch, whose URLSession (iOS) and OkHttpClient
// (Android) are its own — out of reach of BelayPin's hooks, which sit on
// RCTHTTPRequestHandler and OkHttpClientProvider. Every https request to a
// pinned, self-signed host then fails as "certificate invalid" (the tunnel's
// https://127.0.0.1:<port>, the LAN). Expo's documented opt-out, set here so
// every bundle (expo start, export:embed in Xcode/Gradle, EAS) gets it; the
// preset inlines it into node_modules from the bundler's environment.
process.env.EXPO_PUBLIC_USE_RN_FETCH = '1';

const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// The inlined value is not part of Metro's cache key: bump this so a cached
// transform of expo's runtime from before the opt-out is never reused.
config.cacheVersion = `${config.cacheVersion ?? ''}+rn-fetch`;
module.exports = config;
