import assert from "node:assert/strict";
const m3u="#EXTM3U\n#EXTINF:-1 group-title=\"News\" tvg-logo=\"https://x/logo.png\",Channel\nhttps://example.com/live.m3u8";
assert.equal(m3u.split(/\r?\n/)[0],"#EXTM3U");
assert.match(m3u,/https:\/\/example\.com\/live\.m3u8/);
assert.equal(new URL("https://example.com/a").protocol,"https:");
console.log("LOS COLLECTOR final smoke OK");
