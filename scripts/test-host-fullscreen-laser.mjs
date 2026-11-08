import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Map the real component's state hooks by name rather than hard-coded hook indices.
const stateNames = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(ast) === 'useState') {
    stateNames.push(node.name.elements[0].name.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const strokes = [{ id: 'viewer-stroke', points: [{ x: 0.2, y: 0.4 }], shownAt: Date.now() }];
const fullscreenCalls = [];
const sent = [];
let stateIndex, refIndex, currentState;
const hooks = {
  useState(initial) {
    const name = stateNames[stateIndex++];
    return [name in currentState ? currentState[name] : initial, () => {}];
  },
  useRef(initial) {
    const index = refIndex++;
    return { current: index === 0 ? { id: 'preview' } : index === 2 ? { id: 'host-stage' } : initial };
  },
  useCallback: callback => callback,
  useMemo: callback => callback(),
  useEffect() {},
};
const module = { exports: {} };
runInNewContext(code, {
  module, exports: module.exports,
  document: { fullscreenElement: null },
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@/hooks/use-linkcast') return { useLinkcast: () => ({
      voice: {}, laserStrokes: strokes, sendLaserStroke: points => sent.push(points),
      status: 'idle', roomId: '', viewerCount: 0, remoteStream: null,
    }) };
    if (name === '@/hooks/use-saved-preference') return { useSavedPreference() {} };
    if (name === '@/lib/fullscreen') return { requestMediaFullscreen: async (...args) => {
      fullscreenCalls.push(args); return 'viewport';
    } };
    // Imported UI components remain elements in the returned JSX tree.
    return new Proxy({}, { get: (_target, key) => `test:${String(key)}` });
  },
});
function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!node?.props) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}
function render(overrides = {}) {
  currentState = { isPreviewing: true, ...overrides };
  stateIndex = 0; refIndex = 0;
  return module.exports.default();
}
for (const fullscreen of [false, true]) {
  for (const drawing of [false, true]) {
    const tree = render({ isHostFullscreen: fullscreen, hostLaserMode: drawing });
    const overlays = elements(tree, node => node.type === 'test:LaserOverlay');
    assert.equal(overlays.length, 1, 'incoming strokes remain mounted in every host fullscreen/drawing mode');
    assert.equal(overlays[0].props.strokes, strokes, 'received viewer stroke is forwarded');
    assert.equal(overlays[0].props.interactive, drawing, 'drawing toggle controls input only');
  }
}
assert.equal(elements(render({ isPreviewing: false }), node => node.type === 'test:LaserOverlay').length, 0);
let tree = render();
await elements(tree, node => node.props['aria-label'] === '전체화면 보기')[0].props.onClick();
assert.equal(fullscreenCalls.at(-1)[2], true, 'host entry must preserve received overlays');
const beforeToggle = fullscreenCalls.length;
for (const drawing of [false, true]) {
  tree = render({ isHostFullscreen: true, hostLaserMode: drawing });
  const label = drawing ? '레이저 모드 종료' : '레이저 모드 켜기';
  await elements(tree, node => node.props['aria-label'] === label)[0].props.onClick();
  assert.equal(fullscreenCalls.length, beforeToggle, 'host drawing toggle keeps the current fullscreen and incoming overlays');
}
assert.equal(sent.length, 0, 'viewing received strokes does not send strokes');
console.log('PASS: host fullscreen displays received lasers with drawing off/on; entry and mode switches preserve overlays');
