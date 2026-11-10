import test from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks } from './answer-format.ts';

test('technical code keeps URLs, separators and operators as literal data', () => {
  const code = '---\nhttps://example.com/api?x=1\na ** b\n| value |';
  assert.deepEqual(answerBlocks('```text\n' + code + '\n```'), [{ kind: 'code', text: code }]);
});

test('comparison tables preserve column association and escaped pipe values', () => {
  assert.deepEqual(answerBlocks('| 指标 | 2024 | 2025 |\n| --- | ---: | ---: |\n| 营收 | 100 USD | 120 USD |\n| 范围 | A\\|B | C |'), [
    { kind: 'table', headers: ['指标', '2024', '2025'], rows: [['营收', '100 USD', '120 USD'], ['范围', 'A|B', 'C']] },
  ]);
});

test('headings and bullets are readable while ordinary text is preserved', () => {
  assert.deepEqual(answerBlocks('## 结论\n\n- 营收增长\n不支持实时股价。'), [
    { kind: 'heading', text: '结论' }, { kind: 'text', text: '• 营收增长' }, { kind: 'text', text: '不支持实时股价。' },
  ]);
});
