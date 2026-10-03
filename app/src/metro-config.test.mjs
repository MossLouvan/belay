// The bundle must use React Native's fetch, not expo/fetch: BelayPin's
// certificate pinning hooks only RN's networking stack, and with expo/fetch
// every https request to a pinned host fails as "certificate invalid" (the
// tunnel's 127.0.0.1 port showed "Can't reach").
//
//   cd app && node --test src/metro-config.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('metro config opts every bundle out of expo/fetch', () => {
  delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
  const config = require('../metro.config.js');
  assert.equal(process.env.EXPO_PUBLIC_USE_RN_FETCH, '1');
  assert.match(String(config.cacheVersion), /rn-fetch/, 'a stale cached expo runtime must not be reused');
});
