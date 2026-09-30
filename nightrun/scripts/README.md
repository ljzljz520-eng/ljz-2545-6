# scripts

- `benchmark-spatial.js` — 预分段 R*Tree 索引 vs 实时全几何求交：多点位计时并断言结果集一致。
  `npm run benchmark`
- `sync-shared.js` — 把 `server/geo.js`（唯一事实源）复制为 `public/js/geo.js`。
- `browser-check.js` — 真实 Chromium（移动视口 390×844，触摸）端到端走查并产出
  `docs/shots/*.png`：照明筛选、键盘 Enter 进详情、简化公差不改变指标、
  手动位置（无定位权限入口）、离线编辑集合点、网络恢复自动合并、
  白天照片不能选亮灯、键盘焦点可见。

  运行需要 playwright-core 与本机 chromium：
  ```bash
  npm install --no-save playwright-core
  npx playwright-core install chromium
  BASE=http://localhost:3000 node scripts/browser-check.js
  ```
