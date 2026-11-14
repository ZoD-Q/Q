import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Read the actual native palette; do not copy its colors into the assertion.
const source = ts.transpileModule(readFileSync(new URL('../prototype/design.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const module = { exports: {} };
const imports = {
  react: { createContext: () => ({}) },
  'react/jsx-runtime': {},
  'react-native': {},
  'react-native-reanimated': {},
  'lucide-react-native': {},
  'react-native-safe-area-context': {},
  './motion': {},
};
runInNewContext(source, { module, exports: module.exports, require(name) {
  assert.ok(name in imports, `Unexpected palette dependency: ${name}`);
  return imports[name];
} });

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(foreground, background) {
  const [low, high] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

for (const name of ['light', 'dark', 'warm']) test(`${name} native small text and placeholders meet 4.5:1 in their rendered surfaces`, () => {
  const colors = module.exports.themes[name];
  // These pairs are used by Type, Input, source links, Tag/Choice, Action and status text.
  for (const [foreground, background] of [
    ['ink', 'bg'], ['muted', 'bg'], ['muted', 'soft'], ['faint', 'soft'],
    ['accent', 'bg'], ['accent', 'surface'], ['accent', 'soft'], ['accent', 'sidebar'],
    ['accent', 'accentBg'], ['onAccent', 'accent'], ['green', 'greenBg'], ['danger', 'bg'],
  ]) {
    const ratio = contrast(colors[foreground], colors[background]);
    assert.ok(ratio >= 4.5, `${name} ${foreground}/${background}: ${ratio.toFixed(3)}:1`);
  }
});
