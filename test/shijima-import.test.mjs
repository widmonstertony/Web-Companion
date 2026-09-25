import assert from 'node:assert/strict';
import test from 'node:test';
import { convertShijimaArchive, isShijimaArchive } from '../public/shijima-import.js';

const PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+QkViWQAAAABJRU5ErkJggg==',
  'base64',
));

test('converts native English Shijima actions into a safe collection', () => {
  const root = 'Mascots/User/Test Cat.mascot';
  const files = {
    [`${root}/actions.xml`]: new TextEncoder().encode(`
      <Mascot><ActionList><Action Name="Stand" Type="Stay"><Animation>
        <Pose Image="/shime1.png" ImageAnchor="1,1" Velocity="0,0" Duration="4" />
      </Animation></Action></ActionList></Mascot>`),
    [`${root}/behaviors.xml`]: new TextEncoder().encode('<Mascot><Behavior Name="Stand" Frequency="100" /></Mascot>'),
    [`${root}/img/shime1.png`]: PNG,
  };
  assert.equal(isShijimaArchive(files), true);
  const result = convertShijimaArchive(files);
  assert.equal(result.collection.companions.length, 1);
  assert.equal(result.collection.companions[0].id, 'test-cat');
  const manifest = JSON.parse(new TextDecoder().decode(result.files['companions/test-cat/companion.json']));
  assert.equal(manifest.initialState, 'stand');
  assert.equal(manifest.states.stand.frames[0].durationMs, 160);
});

test('imports localized Japanese action tags without executing expressions', () => {
  const root = 'Mascots/User/Miku.mascot';
  const files = {
    [`${root}/actions.xml`]: new TextEncoder().encode(`
      <マスコット><動作リスト><動作 名前="立つ" 種類="静止"><アニメーション>
        <ポーズ 画像="/shime1.png" 基準座標="1,1" 移動速度="0,0" 長さ="4" />
      </アニメーション></動作></動作リスト></マスコット>`),
    [`${root}/behaviors.xml`]: new TextEncoder().encode('<マスコット><行動 名前="立つ" 頻度="100" /></マスコット>'),
    [`${root}/img/shime1.png`]: PNG,
  };
  const result = convertShijimaArchive(files);
  const manifest = JSON.parse(new TextDecoder().decode(result.files['companions/miku/companion.json']));
  assert.equal(manifest.initialState, 'action-1');
  assert.equal(manifest.states['action-1'].label, '立つ');
});
