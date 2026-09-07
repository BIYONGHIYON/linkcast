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
const listeners = new Map();
const fakeWindow = {
  addEventListener: (kind, handler) => listeners.set(kind, handler),
  removeEventListener: (kind, handler) => { if (listeners.get(kind) === handler) listeners.delete(kind); },
};
runInNewContext(compiled, {
  window: fakeWindow,
  require: name => name === 'react'
    ? hooks
    : name === '@/hooks/use-laser-strokes'
      ? { LASER_DURATION_MS: 2500 }
      : require(name),
  module: compiledModule,
  exports: compiledModule.exports,
});
const target = { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) };
const event = (x, pointerId = 1) => ({ pointerId, pointerType: 'touch', button: 0, clientX: x, clientY: 80, currentTarget: target, nativeEvent: {}, preventDefault() {} });
for (const ending of ['onPointerUp', 'onPointerCancel', 'windowRelease']) {
  const sent = [];
  const tree = compiledModule.exports.LaserOverlay({ ratio: 16 / 9, strokes: [], onSend: points => sent.push(points) });
  const handlers = tree.props.children.props;
  handlers.onPointerDown(event(20));
  handlers.onPointerMove(event(100));
  handlers.onPointerCancel(event(100, 2));
  assert.equal(sent.length, 0, 'another finger must not end this stroke');
  if (ending === 'windowRelease') listeners.get('pointerup')(event(140));
  else handlers[ending](event(140));
  handlers.onPointerUp(event(140));
  assert.equal(sent.length, 1, `${ending} must send exactly once`);
  assert.ok(sent[0].length >= 2, 'preserve the dragged path');
  assert.equal(listeners.size, 0, 'release listeners are cleaned up');
}
for (const captureFails of [false, true]) {
  const sent = [];
  const handlers = compiledModule.exports.LaserOverlay({ ratio: 16 / 9, strokes: [], onSend: p => sent.push(p) }).props.children.props;
  const start = event(20);
  start.pointerType = 'mouse';
  if (captureFails) start.currentTarget = { ...target, setPointerCapture() { throw new Error('capture failed'); } };
  handlers.onPointerDown(start);
  // A very short release with no pointermove must retain its endpoint.
  listeners.get('pointerup')(event(20.25));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 2);
  assert.equal(sent[0][1].x, 20.25 / 640);
  handlers.onPointerUp(event(20.25));
  assert.equal(sent.length, 1);
}
// Keep distance long and vary only elapsed time. No render or timer runs between events.
for (const duration of [0, 1, 5, 10, 16]) {
  for (const moveArrives of [false, true]) {
    const sent = [];
    const handlers = compiledModule.exports.LaserOverlay({ ratio: 16 / 9, strokes: [], onSend: p => sent.push(p) }).props.children.props;
    const mouse = (x, timeStamp) => ({ ...event(x), pointerType: 'mouse', timeStamp });
    handlers.onPointerDown(mouse(20, 100));
    if (moveArrives) handlers.onPointerMove(mouse(300, 100 + duration / 2));
    handlers.onPointerUp(mouse(600, 100 + duration));
    assert.equal(sent.length, 1, `rapid ${duration}ms gesture must be sent once`);
    assert.equal(sent[0][0].x, 20 / 640);
    assert.equal(sent[0].at(-1).x, 600 / 640, 'retain the full distance without waiting for a render');
    assert.equal(listeners.size, 0);
  }
}
console.log('PASS: rapid 0-16ms long mouse drags with/without move or render; short drags, capture failure and duplicate endings');
