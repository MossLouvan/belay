import test from 'node:test';
import assert from 'node:assert/strict';
import { addComputerRoute } from './add-computer-route.ts';

test('a typed address arrives on the connect screen filled in', () => {
  assert.deepEqual(addComputerRoute('100.101.102.103'), {
    pathname: '/',
    params: { add: '1', address: '100.101.102.103' },
  });
});

test('surrounding whitespace is dropped before the trip', () => {
  assert.deepEqual(addComputerRoute('  100.101.102.103:8787 \n').params.address, '100.101.102.103:8787');
});

test('a blank field goes nowhere', () => {
  assert.equal(addComputerRoute(''), null);
  assert.equal(addComputerRoute('   '), null);
});

test('asking for the scanner lands on the connect screen with it open', () => {
  assert.deepEqual(addComputerRoute(null), { pathname: '/', params: { add: '1', scan: '1' } });
});

test('every route stands the add-a-computer redirect down', () => {
  assert.equal(addComputerRoute('mac.tail1234.ts.net').params.add, '1');
  assert.equal(addComputerRoute(null).params.add, '1');
});
