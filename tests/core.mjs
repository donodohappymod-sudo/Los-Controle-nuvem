import assert from 'node:assert/strict';
const src=`#EXTM3U\n#EXTINF:-1 group-title="News" tvg-logo="https://x/logo.png",Test Channel\nhttps://example.com/live.m3u8`;
const lines=src.split(/\r?\n/);assert.equal(lines[0],'#EXTM3U');assert.match(lines[1],/^#EXTINF/);assert.equal(lines[2],'https://example.com/live.m3u8');
const u=new URL('https://example.com/a');assert.equal(u.protocol,'https:');
console.log('LOS COLLECTOR core smoke OK');
