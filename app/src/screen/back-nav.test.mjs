// Unit tests for the desktop's Back decision.
//
//   cd app && node --test src/screen/back-nav.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACK_TARGET_ROUTES,
  backFallbackHref,
  planScreenBack,
  previousRouteName,
} from './back-nav.ts';

test('previousRouteName reads the entry beneath the focused route', () => {
  const routes = [{ name: 'devices' }, { name: '(home)' }];
  assert.equal(previousRouteName(routes, 1), 'devices');
});

test('previousRouteName is null at the bottom of the stack or with bad state', () => {
  const routes = [{ name: '(home)' }];
  assert.equal(previousRouteName(routes, 0), null, 'nothing underneath');
  assert.equal(previousRouteName(routes, undefined), null, 'no index yet');
  assert.equal(previousRouteName(undefined, 0), null, 'no state yet');
  assert.equal(previousRouteName(routes, 5), null, 'index past the end');
  assert.equal(previousRouteName(routes, -1), null, 'negative index');
  assert.equal(previousRouteName(routes, 0.5), null, 'non-integer index');
});

test('the fallback is the computers list, or pairing when nothing is paired', () => {
  assert.equal(backFallbackHref(3), '/devices');
  assert.equal(backFallbackHref(1), '/devices');
  assert.equal(backFallbackHref(0), '/');
});

test('pops when the computers list or pairing flow is directly underneath', () => {
  for (const previousRoute of BACK_TARGET_ROUTES) {
    assert.deepEqual(
      planScreenBack({ canGoBack: true, previousRoute, deviceCount: 2 }),
      { kind: 'pop' },
      `pops to ${previousRoute}`,
    );
  }
});

test('never pops into a duplicate desktop; replaces with the list instead', () => {
  assert.deepEqual(
    planScreenBack({ canGoBack: true, previousRoute: '(home)', deviceCount: 2 }),
    { kind: 'replace', href: '/devices' },
  );
});

test('with no history the desktop is replaced by the list', () => {
  assert.deepEqual(
    planScreenBack({ canGoBack: false, previousRoute: null, deviceCount: 1 }),
    { kind: 'replace', href: '/devices' },
  );
});

test('the router saying canGoBack without a known previous route is not trusted', () => {
  assert.deepEqual(
    planScreenBack({ canGoBack: true, previousRoute: null, deviceCount: 1 }),
    { kind: 'replace', href: '/devices' },
  );
});

test('with nothing paired, Back lands on the pairing flow', () => {
  assert.deepEqual(
    planScreenBack({ canGoBack: false, previousRoute: null, deviceCount: 0 }),
    { kind: 'replace', href: '/' },
  );
});
