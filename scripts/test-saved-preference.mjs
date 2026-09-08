import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../hooks/use-saved-preference.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function setup(stored, blocked = false) {
  let loaded = false;
  let value = 200;
  let effects = [];
  const writes = [];
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: () => ({
      useState: () => [loaded, next => { loaded = next; }],
      useEffect: effect => effects.push(effect),
    }),
    localStorage: {
      getItem() { if (blocked) throw new Error('blocked'); return stored; },
      setItem(key, next) { if (blocked) throw new Error('blocked'); writes.push(next); },
    },
  });
  return { exports, writes, get value() { return value; }, render() {
    effects = [];
    exports.useSavedPreference('volume', value, next => { value = next; }, exports.validVolume);
    return effects;
  } };
}
const saved = setup('480');
const initial = saved.render();
initial.forEach(effect => effect());
initial.forEach(effect => effect()); // Strict Mode effect replay before rerender.
assert.equal(saved.value, 480);
assert.deepEqual(saved.writes, [], 'initial effects must not overwrite saved volume');
saved.render()[1]();
assert.deepEqual(saved.writes, ['480']);
for (const input of ['broken JSON', 'null', '601', '-1', '"200"']) {
  const invalid = setup(input);
  invalid.render().forEach(effect => effect());
  assert.equal(invalid.value, 200);
}
const blocked = setup(null, true);
blocked.render().forEach(effect => effect());
blocked.render()[1]();
assert.equal(blocked.value, 200);
assert.equal(saved.exports.validDevice('capture-card'), true);
assert.equal(saved.exports.validDevice({}), false);
assert.equal(saved.exports.validSensitivity(101), false);
console.log('PASS: preference restore, hydration/Strict Mode safety, validation, blocked storage');
