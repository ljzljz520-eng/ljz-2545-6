/* 真实浏览器（移动视口）走查：筛选、键盘焦点、详情、简化公差、离线集合编辑。
 * 需要 npx playwright-core install chromium */
'use strict';
const path = require('path');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd()] }));

const BASE = process.env.BASE || 'http://localhost:3106';
const SHOTS = path.join(__dirname, '..', 'docs', 'shots');
require('fs').mkdirSync(SHOTS, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 固定“现在”为 2026-09-30 20:30 (+08) —— 通过给所有 API 加 ?now 不易，
  // 种子日期就是相对真实 now 的近期记录，故浏览器走真实时钟。
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
  await page.waitForSelector('.route-card');
  await page.screenshot({ path: path.join(SHOTS, '01-home.png') });

  // 1) 触摸：点“照明良好”芯片
  await page.locator('.chip[data-light="lit"]').tap();
  await page.waitForTimeout(300);
  const cards1 = await page.locator('.route-card h3').allTextContents();
  console.log('照明良好筛选:', cards1);
  if (!cards1.length) throw new Error('lit filter empty');

  // 2) 键盘：芯片可见焦点；聚焦到第一条路线卡，Enter 打开详情
  const firstCard = page.locator('.route-card').first();
  await firstCard.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#map');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '02-detail.png') });
  const metricText = await page.locator('.metric-grid').innerText();
  const crossingsText = await page.locator('#crossList').innerText();
  console.log('指标区含距离/坡度:', /距离/.test(metricText), /坡度/.test(metricText));
  console.log('交叉点:', crossingsText.replace(/\s+/g, ' ').slice(0, 80));

  // 3) 简化公差：拖动 slider，指标不变
  const before = await page.locator('.metric-grid').innerText();
  await page.locator('#tol').fill('80');
  await page.waitForTimeout(400);
  const after = await page.locator('.metric-grid').innerText();
  console.log('公差改变后指标一致:', before === after);
  if (before !== after) throw new Error('指标随简化公差变化');
  await page.screenshot({ path: path.join(SHOTS, '03-detail-simp80.png') });

  // 4) 手动位置入口（在首页）
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#btnManual');
  await page.locator('#btnManual').tap();
  await page.waitForSelector('#mLon');
  await page.fill('#mLon', '120.2131');
  await page.fill('#mLat', '30.2386');
  await page.locator('#mOk').tap();
  await page.waitForTimeout(400);
  console.log('手动位置状态:', await page.locator('#locStatus').innerText());
  await page.screenshot({ path: path.join(SHOTS, '04-manual-loc.png') });

  // 5) 固定进入江湾大桥详情，离线编辑集合点
  await page.goto(BASE + '/#detail/bridge', { waitUntil: 'networkidle' });
  await page.waitForSelector('#mSaveColl');
  await page.context().setOffline(true);
  await page.fill('#mLon2', '120.2131');
  await page.fill('#mLat2', '30.2386');
  await page.fill('#mLabel', '桥南夜跑集合');
  await page.fill('#mExit', '600');
  await page.fill('#mNote', '带反光背心');
  await page.locator('#mSaveColl').tap();
  await page.waitForTimeout(300);
  const collStatus = await page.locator('#collStatus').innerText();
  console.log('离线保存反馈:', collStatus.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, '05-offline-edit.png') });

  // 6) 我的集合页可见离线条目；恢复在线后自动同步
  await page.goto(BASE + '/#collections', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '06-collections-offline.png') });
  const collBefore = await page.locator('main').innerText();
  console.log('离线下集合页含本地条目:', /桥南夜跑集合|待同步/.test(collBefore));
  await page.context().setOffline(false);
  // 等待 online 事件触发的自动同步完成（outbox 清空）
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('nr.outbox')) || []).length === 0, null, { timeout: 8000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const collAfter = await page.locator('main').innerText();
  console.log('恢复后集合仍在且无待同步:', /桥南夜跑集合/.test(collAfter), !/待同步/.test(collAfter));
  await page.screenshot({ path: path.join(SHOTS, '07-collections-synced.png') });

  // 7) 观察提交：白天照片不能选亮灯（选 day_photo 时 lit 被置空）
  await page.goto(BASE + '/#detail/rainbow', { waitUntil: 'networkidle' });
  await page.waitForSelector('#rSrc');
  await page.selectOption('#rSrc', 'day_photo');
  const litVal = await page.locator('#rLit').inputValue();
  console.log('白天照片 lit 被置空:', litVal === '');

  // 8) 焦点可见性：检测 :focus-visible outline
  await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  const focusOutline = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return cs.outlineWidth !== '0px' && cs.outlineStyle !== 'none';
  });
  console.log('键盘焦点描边可见:', focusOutline);

  if (errors.length) { console.log('页面错误:', errors); process.exitCode = 1; }
  await browser.close();
  console.log('screenshots →', SHOTS);
})().catch(e => { console.error(e); process.exit(1); });
