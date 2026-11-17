// Bilder im KI-Chat: Prüfung der eingefügten Bilder und Umwandlung für die ChatGPT-Responses-API
const test = require('node:test');
const assert = require('node:assert/strict');
const { imageBlocks } = require('../src/main/ai-tools');
const { toInputContent } = require('../src/main/chatgpt');

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

test('Bilder werden zu Claude-Bildblöcken mit Namen', () => {
  const out = imageBlocks([{ name: 'Skript, S. 3', mediaType: 'image/png', data: png }]);
  assert.deepEqual(out, [
    { type: 'text', text: 'Bild: Skript, S. 3' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
  ]);
});

test('Ungültige Bilder werden verworfen', () => {
  assert.deepEqual(imageBlocks(null), []);
  assert.deepEqual(imageBlocks([{ mediaType: 'image/svg+xml', data: png }]), [], 'SVG nicht erlaubt');
  assert.deepEqual(imageBlocks([{ mediaType: 'image/png', data: 'kein base64!' }]), [], 'kein Base64');
  assert.deepEqual(imageBlocks([{ mediaType: 'image/png', data: 'A'.repeat(8 * 1024 * 1024) }]), [], 'zu groß');
  assert.deepEqual(imageBlocks([{ mediaType: 'image/png' }]), [], 'ohne Daten');
});

test('Höchstens 8 Bilder pro Nachricht', () => {
  const many = Array.from({ length: 12 }, () => ({ mediaType: 'image/jpeg', data: png }));
  assert.equal(imageBlocks(many).filter((b) => b.type === 'image').length, 8);
});

test('ChatGPT: Text- und Bildblöcke werden zu input_text und input_image', () => {
  const content = toInputContent([{ type: 'text', text: 'Hallo' }, ...imageBlocks([{ mediaType: 'image/jpeg', data: png }]), { type: 'document', source: {} }]);
  assert.deepEqual(content, [
    { type: 'input_text', text: 'Hallo' },
    { type: 'input_image', image_url: `data:image/jpeg;base64,${png}`, detail: 'auto' },
  ]);
});
