# 验收手册（五场景）

运行：`node --test test/acceptance.test.js`（内存数据库，自动播种江湾市数据，时间用固定的 UTC+8 时刻）。

| # | 场景 | 位置 | 关键断言 |
|---|---|---|---|
| 1 | **跨桥投影** | test 1–2 | 桥面探测点投影距离≈0 且桩号落在桥面段；彩虹桥上的点按真实几何只归 rainbow；`/api/nearest` 与 5m/80m 简化公差无关；长度、交叉数恒定 |
| 2 | **旧线路收藏** | test 3 | 已废弃 `canal-old` 收藏后仍在 `/api/collections`（带 `public.status=deprecated`）；公共侧几何升到 v2，个人集合点坐标逐字段不变 |
| 3 | **观测冲突** | test 4 | bridge 夜间=conflict 且冲突区间落在 350–900 m；中午=unknown；rainbow 为“仅白天照片+过期夜访”→unknown；day_photo 提交 lit 返回 422；合法夜访推进 obs_version |
| 4 | **两设备改集合点** | test 5 | A 写集合点、B 写退出点后两者都在；先有较新备注时 B 的旧时间戳写入进 dropped_fields；更新时间戳后新值胜出；公共注意 `n-bridge-1` 原样保留 |
| 5 | **网络恢复** | test 5/网络恢复 | 离线 outbox（收藏2条+墓碑删除1条）经 `/api/collections/sync` 一次重放：两条出现、oldtown 不出现在列表且底层墓碑保留；离线备注与服务端另一设备的新集合点按字段共存，退出点不丢 |

补充核查：

```bash
node scripts/benchmark-spatial.js   # 两空间策略结果集一致 + 平均耗时
# 手工浏览：
PORT=3000 node server/app.js        # http://localhost:3000
# 建议把浏览器 DevTools 切到手机视图；断网可在 Network 面板切 Offline 验证离线编辑与恢复横幅
```

界面中的每一条“照明”结论都可在详情页“照明观察证据”里找到对应的观察时间、覆盖桩号、观察人与说明；
应用不提供、也不应被理解为任何“安全保证”。
