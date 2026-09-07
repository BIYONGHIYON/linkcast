import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../lib/room-input.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { normalizeRoomValue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const code = 'da5790dd4e06';
const base = 'https://linkcast.byeonghyeon383.workers.dev/';
for (const input of [code, ` ${code} `, code.toUpperCase(), `${base}?room=${code}&mode=viewer`, `${base}?mode=viewer&room=${code}`, `${base}?room=${code}#video`, `${base}?room=${code}\\&mode=viewer`, `${base}?mode=viewer&amp;room=${code}`, `[Linkcast](${base}?room=${code}\\&mode=viewer)`, `?room=${code}&mode=viewer`, `${base}?room=%64a5790dd4e06`]) {
  assert.equal(normalizeRoomValue(input), code, input);
}
for (const input of ['', base, `${base}?room=%`, `${base}?room=wrong/code`, 'wrong code', 'https://[broken']) assert.equal(normalizeRoomValue(input), '');
console.log('PASS: code and shared links resolve to the same room; invalid inputs are rejected');
