'use strict';
/**
 * 空间数据库（SQLite）。
 *
 * 两种求交策略都在这里，供 /api/spatial/query 对比：
 * - index    ：预先固定分段（100m）+ 250m 网格表，候选裁剪后【再对段内原几何精确校验】。
 * - realtime ：不使用任何预建索引，直接对所有候选路线的 densify 原几何逐边算最近点。
 *
 * 注意：索引只负责“快速缩小候选集”，距离结果两种模式都由同一套原几何数学给出
 * （段内 points 是 densify 原几何切片，不是简化线），所以缩放/展示级别不会改变判断。
 */
const Database = require('better-sqlite3');

const GRID = 250;

function createSpatialDb(filePath = ':memory:') {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS route_segments (
      route_id TEXT NOT NULL,
      seg_index INTEGER NOT NULL,
      cum_start REAL, cum_end REAL,
      minx REAL, miny REAL, maxx REAL, maxy REAL,
      midx REAL, midy REAL,
      PRIMARY KEY (route_id, seg_index)
    );
    CREATE TABLE IF NOT EXISTS seg_grid (
      gx INTEGER NOT NULL, gy INTEGER NOT NULL,
      route_id TEXT NOT NULL, seg_index INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_grid ON seg_grid(gx, gy);
    CREATE INDEX IF NOT EXISTS idx_seg_route ON route_segments(route_id);
  `);
  return db;
}

function upsertCatalog(db, catalog, segM = 100) {
  const insSeg = db.prepare(`INSERT OR REPLACE INTO route_segments
    (route_id, seg_index, cum_start, cum_end, minx, miny, maxx, maxy, midx, midy)
    VALUES (@routeId,@segIndex,@cumStart,@cumEnd,@minx,@miny,@maxx,@maxy,@midx,@midy)`);
  const delGrid = db.prepare('DELETE FROM seg_grid');
  const insGrid = db.prepare('INSERT INTO seg_grid (gx,gy,route_id,seg_index) VALUES (?,?,?,?)');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM route_segments').run();
    delGrid.run();
    for (const route of catalog.routes.values()) {
      const seen = new Set();
      for (const seg of route.segments) {
        insSeg.run({
          routeId: route.id, segIndex: seg.segIndex,
          cumStart: seg.cumStart, cumEnd: seg.cumEnd,
          minx: seg.bbox.minX, miny: seg.bbox.minY, maxx: seg.bbox.maxX, maxy: seg.bbox.maxY,
          midx: seg.mid.x, midy: seg.mid.y,
        });
        const gx0 = Math.floor(seg.bbox.minX / GRID), gx1 = Math.floor(seg.bbox.maxX / GRID);
        const gy0 = Math.floor(seg.bbox.minY / GRID), gy1 = Math.floor(seg.bbox.maxY / GRID);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) {
            const key = gx + ':' + gy + ':' + route.id + ':' + seg.segIndex;
            if (seen.has(key)) continue;
            seen.add(key);
            insGrid.run(gx, gy, route.id, seg.segIndex);
          }
        }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO meta(k,v) VALUES('seg_m',?)`).run(String(segM));
  });
  tx();
}

function cellListForRadius(x, y, r) {
  const gx0 = Math.floor((x - r) / GRID), gx1 = Math.floor((x + r) / GRID);
  const gy0 = Math.floor((y - r) / GRID), gy1 = Math.floor((y + r) / GRID);
  const out = [];
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) out.push([gx, gy]);
  return out;
}

module.exports = { createSpatialDb, upsertCatalog, cellListForRadius, GRID };
