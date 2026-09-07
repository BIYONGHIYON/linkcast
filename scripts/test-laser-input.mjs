import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../components/laser-overlay.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const compiledModule = { exports: {} };
// Exercise the actual event handlers without claiming browser gesture/DOM coverage.
const hooks = {
  useRef: current => ({ current }),
  useEffect: () => {},
  useState: initial => [initial?.width === 0 ? { width: 640, height: 360 } : initial, () => {}],
};
runInNewContext(compiled, { require: name => name === 'react' ? hooks : require(name), module: compiledModule, exports: compiledModule.exports });
const target = { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) };
const event = (x, pointerId = 1) => ({ pointerId, pointerType: 'touch', button: 0, clientX: x, clientY: 80, currentTarget: target, nativeEvent: {}, preventDefault() {} });
for (const ending of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture']) {
  const sent = [];
  const tree = compiledModule.exports.LaserOverlay({ ratio: 16 / 9, stroke: null, onSend: points => sent.push(points) });
  const handlers = tree.props.children.props;
  handlers.onPointerDown(event(20));
  handlers.onPointerMove(event(100));
  handlers.onPointerCancel(event(100, 2));
  assert.equal(sent.length, 0, 'another finger must not end this stroke');
  handlers[ending](event(140));
  handlers.onLostPointerCapture(event(140));
  handlers.onPointerUp(event(140));
  assert.equal(sent.length, 1, `${ending} must send exactly once`);
  assert.ok(sent[0].length >= 2, 'preserve the dragged path');
}
console.log('PASS: release, cancel, capture loss preserve strokes; duplicate endings and other fingers do not resend');
