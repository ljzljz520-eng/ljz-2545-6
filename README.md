# 潼川夜跑（城市夜跑主题站原型）

移动优先的夜跑路线筛选站。筛选条件综合**距离、坡度、照明观察、补给时段**；
空间数据库管理路线分段与观察版本；个人集合点可离线编辑、退出点可保存。

> 本站只汇总**可核查的观察与几何数据**，**不承诺任何路线安全**。
> 照明信息是带时间与覆盖范围的夜间观察：白天照片不等于夜里亮，观察会过期、会冲突。

## 快速开始

```bash
npm start        # http://localhost:4173
npm test         # 11 组验收（跨桥投影/旧线收藏/观测冲突/双机合并/网络恢复…）
npm run bench    # 预先分段索引 vs 实时空间求交 对比
```

仅依赖 Node 内置模块 + `better-sqlite3`（已在 node_modules）。

## 它如何对应需求

| 需求 | 落地 |
| --- | --- |
| 移动首页突出路线筛选 | `public/`：筛选卡（距离/坡度/近期夜间亮灯/此刻营业补给）置顶，底部 4 标签 |
| API 结合距离·坡度·照明记录·补给时段 | `GET /api/routes` 组合筛选；详情含五态照明、退出点营业状态 |
| 空间数据库管理分段与观察版本 | SQLite：`route_segments`+`seg_grid` 索引、`observations`、`notices(version)`、`collection_revs` |
| 保存集合及退出点 | 个人集合 points/favorites 可离线增删，退出点从补给投影到路线原几何 |
| 照明=有时间/覆盖的观察 | `nightVisit + photo=night + visitedAt + coverage + cumStart/End`；白天照片单列不计入 |
| 简化线只用于展示 | 接口字段 `geometryDisplayRole:"render-only"`；距离/坡度/交叉点走 densify 原几何 |
| 缩放不改变路线判断 | A6：抽稀只减点，统计值恒定；空间查询两种模式结果一致 |
| 预分段索引 vs 实时求交 | `POST /api/spatial/query?mode=index|realtime` + 页面“比较”按钮 + bench |
| 提示定位 / 数据过期 / 失去权限手动入口 | 吸附结果解释、过期横幅、权限错误自动展开手动坐标入口 |
| 个人集合离线合并 vs 公共路线更新分离 | 字段级三路合并；notices 独立 PATCH，集合路径不写公共信息 |
| 推荐可核查 | 给出原始量、观察 ID、版本历史、ETag、`?now=` 可复现 |
| 界面不承诺安全 | 顶栏/详情/表单多处非安全声明，文案无“安全/放心” |
| 原创设计：手机与键盘路径 | `docs/design.md` 第 8、9 节；快捷键 1-4/F/L/M/S/Esc |

## 目录

```
server/geometry.js     densify / RDP简化 / 坡度 / 交叉 / 跨河判定 / 跨桥吸附
server/catalog.js      原几何 -> 长度/坡度/分段/交叉点/退出点
server/spatial-db.js   SQLite 分段 + 250m 网格索引
server/observations.js 照明五态、冲突/过期、墙上时间补给时段
server/store.js        观察/公共注意/集合版本化字段级三路合并
server/service.js      筛选 + 双模式空间查询 + 吸附
server/app.js          HTTP 入口（node:http）
public/                移动优先 SPA（HTML/CSS/原生 JS + SVG 地图）
test/acceptance.js     11 组验收
test/bench-spatial.js  空间策略性能/一致性对比
docs/design.md         原创设计说明（含手机与键盘路径）
data/city.seed.json    虚构城市潼川：河、两桥、5 路线、观察、补给、注意
```

## 方法论语义（重要）

- 亮灯比例：50m 采样段，每段取**最近 14 天**夜间实地观察；超期记 stale，无记录记 unknown；
  同段亮/暗覆盖差 ≥0.5 记 conflict（不取平均）。
- 坡度：50m 滑动窗口 `|Δ高程|/水平距` 最大值。
- 跨桥吸附：非桥边若 GPS→垂足连线穿越河道多边形则拒绝；GPS 在河内时只允许桥边。
- 合并：`(base, server, client)` 字段级三方比较；同字段双改返回 409，由用户决定后 force。

虚构城市使用局部米坐标（边界见种子 `crs` 说明）；接入真实城市时在该处放投影定义（EPSG 等），
跨桥投影与其余算法不变。
