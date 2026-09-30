/* 前端 store 的字段级合并/outbox 逻辑在 Node 下直接验证 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'store.js'), 'utf8');
function freshStore() {
  const storage = {};
  const sandbox = {
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: k => { delete storage[k]; },
    },
    navigator: { onLine: true },
    Math, Date, JSON, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(storeSrc, sandbox);
  return sandbox.NRStore;
}

test('本地字段级合并：不同字段共存，同字段新者胜', () => {
  const S = freshStore();
  const base = { geom_version: 1, obs_version: 2 };
  S.localEdit('bridge', { meeting: { lon: 1, lat: 2, label: 'A点' } }, base);
  S.localEdit('bridge', { exit_station: 400, note: '备' });
  const c = S.getCollection('bridge');
  assert.deepEqual([c.meeting_lon, c.meeting_lat], [1, 2]);
  assert.equal(c.meeting_label, 'A点');
  assert.equal(c.exit_station, 400);
  assert.equal(c.note, '备');
  assert.equal(S.outbox().length, 2);
});

test('墓碑删除与手动位置持久化', () => {
  const S = freshStore();
  S.localEdit('park', { saved_at: 'x' });
  S.localEdit('park', { deleted: true });
  const all = S.getCollections();
  assert.equal(all.park.deleted, 1);
  assert.equal(Object.values(all).filter(x => !x.deleted).length, 0);
  S.manualLocation({ lon: 120.2, lat: 30.25 });
  assert.deepEqual(S.manualLocation(), { lon: 120.2, lat: 30.25 });
});

test('syncNow：服务端权威值与本地未同步字段再合并，清空 outbox', async () => {
  const S = freshStore();
  S.localEdit('bridge', { meeting: { lon: 1, lat: 2, label: '本地A' } });
  const calls = {};
  const fakeApi = {
    async syncCollections(items) {
      calls.items = items;
      // 服务端返回：meeting 被另一设备更新（更新时间戳），合并后带该值
      return {
        items: [Object.assign({}, items[0], {
          meeting_lon: 9, meeting_lat: 9, meeting_label: '远端B', meeting_ts: Date.now() + 5000,
          exit_station: 800, exit_ts: Date.now() + 4000,
        })],
        conflicts: [],
      };
    },
  };
  const r = await S.syncNow(fakeApi);
  assert.equal(r.synced, 1);
  const c = S.getCollection('bridge');
  assert.equal(c.meeting_label, '远端B', '远端较新集合点生效');
  assert.equal(c.exit_station, 800, '服务端带回的退出点合并入本地');
  assert.equal(S.outbox().length, 0, '队列已清空');
});
