# 算法与判定说明（可核查）

本文档列出系统的每个关键判定、数据来源与验证方式，便于独立核查。
所有几何指标在服务端 `server/geo.js` 中计算，浏览器与 Node 共用同一份 UMD 代码
（`public/js/geo.js` 由 `scripts/sync-shared.js` 从 `server/geo.js` 复制）。

## 1. 距离 / 坡度 / 交叉点只来自原几何

| 指标 | 计算方式 | 输入 | 不允许的来源 |
|---|---|---|---|
| 路线长度 | 逐顶点 haversine 求和 | `route_versions.coords_json`（原几何） | 简化线、屏幕像素 |
| 桩号 station | 沿原几何的累计长度 | 同上 | 包围盒插值 |
| 最大/平均坡度 | 相邻顶点高程差 / haversine 段长 | 原几何第三维高程 | 地图缩放后的几何 |
| 平面交叉点 | 投影到局部米坐标系后逐线段求交（参数 t/u） | 两条原几何 | 包围盒相交、图标位置 |
| 最近路线投影 | 点对每条原线段做垂足投影，取全局最小 | 原几何 | 只比较包围盒距离 |

- 简化线使用 Douglas–Peucker（米制公差），**仅用于 SVG 绘制**；
  详情页可以拖动 5–80 m 公差，指标区数字、交叉数、`/api/nearest` 结果都不随之变化
  （见验收测试 “结果不随显示缩放/简化改变”）。
- 几何每次更新写入新 `geom_version`，旧版本几何保留在 `route_versions`；
  交叉点物化表 `crossings` 在几何更新后整体重建，并记录双方版本号。

### 局部投影
城市尺度采用等距圆柱投影到米（`projector(lon0,lat0)`），原点为城市中心（元数据 `meta.city_center`）。
跨河/跨桥判定逐段进行：桥面线段与岸线段即使包围盒重叠，也只有真正最近的垂足段会胜出
（验收 1：桥上探测点只命中桥；河面点按真实几何分配到岸线或桥）。

## 2. 照明是“观察”，不是属性

`observations` 是**只追加**的不可变记录，每条带 `obs_version`：

- `source = night_visit | report | day_photo`
- `lit = 1 | 0 | NULL`，覆盖桩号 `[cov_from, cov_to]`
- `observed_at`（观察时刻）、`schedule`（声明的生效时段，如每天 18:00–06:00，可跨 0 点）
- `observer`、`note`（建议写维护单号/灯具位置，可核查）

`evaluateLighting(length, observations, now)` 的纳入口径：

1. **白天照片直接排除**：`day_photo` 只说明灯具存在，永远不计入亮/暗证据，
   服务端提交接口对 `day_photo + lit≠null` 返回 422；
2. 当前时刻必须落在观察声明的 schedule 内（中午查任何夜间观察 → `unknown`）；
3. 观察时刻距 `now` 不超过 180 天（`STALE_LIGHTING_MS`），过期的不计入但保留可见并打“过期”；
4. 区间用事件扫描叠加：同一桩号同时出现 lit/dark 记为 `conflict` 并给出区间；
5. 其余按点亮覆盖长度占比给出 `lit (≥80%) / partial / dark / unknown`。

API 返回完整 `evidence` 列表（含每条观察是否在时段、是否过期、观察人、时间），
前端详情页原样列出，保证结论可追溯。

## 3. 补给时段

`supplies.windows` 为多个 `{days[1..7], start, end}` 窗口（可跨 0 点，如 00:00–23:59）。
`supplyOpen(windows, now)` 判定“此刻是否营业”，筛选参数 `supply_open=1` 才会要求命中。

## 4. 空间查询：预分段索引 vs 实时求交

- **A 预分段索引**：路线按固定 100 m 重新采样为 chunks（`geo.chunkByStation`），
  每块写入 R*Tree（`chunks_rtree`）包围盒。查询先用 R*Tree 拿候选路线，再对原几何精确投影。
  只 JOIN 当前 `geom_version` 且 `status='active'`。
- **B 实时求交**：扫描全部 active 路线的当前原几何，逐条垂足投影，无索引。
- `/api/spatial/benchmark` 返回两者的命中集合并比对；
  `scripts/benchmark-spatial.js` 在多查询点 × 200 次下计时并断言结果集完全一致。
- 权衡：A 更快但有写放大（几何升版必须重建 chunks/rtree）与过期风险；
  B 永远新鲜但成本随总线段数线性增长。切换策略的前提是结果集一致。

## 5. 个人集合 vs 公共数据：两条独立合并通道

- 个人集合（收藏/集合点/退出点/备注）按**字段**存时间戳：
  `saved_at_ts / meeting_ts / exit_ts / note_ts / deleted_ts`。
  合并规则：服务端字段为空 → 直接采纳（两设备改不同字段都保留）；
  双方都有值 → 时间戳新者胜，旧值进入 `conflicts.dropped_fields` 回报。
  删除用墓碑（`deleted/deleted_ts`），防止旧设备重连把条目“复活”。
- 公共路线几何/观察版本由 `GET /api/collections` 附带（`public.geom_version` 等），
  前端据此提示“几何已更新/有新观察”，但个人字段不动。
- 公共注意 `notices` 是**只读通道**（`GET /api/notices`），集合同步接口不写 notices，
  任何离线编辑都无法覆盖公共注意。

## 6. 数据过期与定位降级

- `GET /api/hints?now=` 汇总 `unknown/stale/day_photo_only` 路线与当前版本号，
  供首页“数据过期”提示；
- 定位权限拒绝/超时/不支持时，前端提供手动经纬度入口并存于 localStorage，
  所有按距离筛选都通过同一个 `/api/nearest` / `routes?lon=&lat=` 服务端判定，
  手动位置与 GPS 位置走完全相同的几何路径。

## 7. 复现实验

```bash
node scripts/benchmark-spatial.js      # 两策略耗时 + 结果集一致性
node --test test/                      # 五个验收场景（见 docs/ACCEPTANCE.md）
# 任意时刻复现照明判定：
curl "$HOST/api/routes/bridge?now=$(date -d '2026-09-30 20:30 +0800' +%s)000"
curl "$HOST/api/routes/bridge?now=$(date -d '2026-09-30 12:00 +0800' +%s)000"
```
