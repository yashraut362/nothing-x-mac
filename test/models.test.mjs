import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesForName } from '../web/core/models.js';

test('a Fast Pair model ID gives the neckband its form and colour', () => {
  const orange = capabilitiesForName('CMF Neckband Pro', '4DFC4A');
  assert.equal(orange.form, 'neckband');
  assert.equal(orange.color, 'orange');
  assert.equal(capabilitiesForName('CMF Neckband Pro', 'ae35fd').color, 'black');
});

test('the model ID identifies a renamed neckband', () => {
  const caps = capabilitiesForName("Mostafa's buds", '26C190');
  assert.equal(caps.form, 'neckband');
  assert.equal(caps.color, 'white');
  assert.equal(caps.ring, 'headphone');
});

test('without a model ID the name still decides, with no colour', () => {
  const caps = capabilitiesForName('CMF Neckband Pro');
  assert.equal(caps.form, 'neckband');
  assert.equal(caps.color, null);
  assert.equal(capabilitiesForName('CMF Buds 2 Plus', 'FFFFFF').form, null);
  assert.equal(capabilitiesForName('Studio', 'B192').pro, true);
});
