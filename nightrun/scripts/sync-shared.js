// 保持唯一事实源 server/geo.js 与浏览器副本 public/js/geo.js 一致
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'geo.js'));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'js', 'geo.js'), src);
console.log('geo.js synced to public/js, bytes', src.length);
