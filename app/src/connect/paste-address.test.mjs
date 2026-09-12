// What the Paste button on the connect screen must accept.
//
// The founder's route in is: open Tailscale, copy the computer's address,
// tap Paste. Whatever that copy actually carries — a bare IP, a full URL, a
// trailing newline, a quoted line out of a note — has to land in the field as
// something the address parser recognises.
//
//   cd app && node --test src/connect/paste-address.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePastedAddress } from './address-input.ts';

test('a bare Tailscale address comes through unchanged', () => {
  assert.equal(normalizePastedAddress('100.101.102.103'), '100.101.102.103');
});

test('the trailing newline a mobile copy drags along is dropped', () => {
  assert.equal(normalizePastedAddress('100.101.102.103\n'), '100.101.102.103');
});

test('a full URL copied from a browser is reduced to the address', () => {
  assert.equal(normalizePastedAddress('http://100.101.102.103:8787/'), '100.101.102.103');
});

test("the host agent's own port is implied, so it is not repeated in the field", () => {
  assert.equal(normalizePastedAddress('100.101.102.103:8787'), '100.101.102.103');
});

test('a non-default port survives — it is the only way to reach that host', () => {
  assert.equal(normalizePastedAddress('100.101.102.103:9000'), '100.101.102.103:9000');
});

test('an https URL on 443 keeps neither scheme nor port', () => {
  assert.equal(normalizePastedAddress('https://pc.tail1234.ts.net'), 'pc.tail1234.ts.net');
});

test('a MagicDNS name is lower-cased the way the parser reads it', () => {
  assert.equal(normalizePastedAddress('  PC.Tail1234.TS.NET  '), 'pc.tail1234.ts.net');
});

test('a labelled line loses its label — the address is the token that parses', () => {
  assert.equal(normalizePastedAddress('Address: 100.101.102.103'), '100.101.102.103');
});

test('a multi-line copy takes the line that is an address', () => {
  assert.equal(normalizePastedAddress('moss-macbook\n100.101.102.103\nConnected'), '100.101.102.103');
});

test('quotes and trailing punctuation from a note are stripped', () => {
  assert.equal(normalizePastedAddress('"100.101.102.103".'), '100.101.102.103');
});

test('a pairing link is handed back whole — Connect pairs straight from it', () => {
  const link = 'belay://pair?host=http://100.101.102.103:8787&code=123456';
  assert.equal(normalizePastedAddress(link), link);
});

test('the pre-rename tether: link is still a link, not an address', () => {
  assert.equal(normalizePastedAddress('tether://pair?code=123456'), 'tether://pair?code=123456');
});

test('an empty clipboard normalises to nothing, so the caller can say so', () => {
  assert.equal(normalizePastedAddress(''), '');
  assert.equal(normalizePastedAddress('   \n  '), '');
});

test('unreadable text comes back trimmed so the feedback line can explain it', () => {
  assert.equal(normalizePastedAddress('  hello there, this is not an address  '), 'hello there, this is not an address');
});

test('a non-string clipboard payload is not trusted', () => {
  assert.equal(normalizePastedAddress(undefined), '');
  assert.equal(normalizePastedAddress(null), '');
  assert.equal(normalizePastedAddress(42), '');
});
