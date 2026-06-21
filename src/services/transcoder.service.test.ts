import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMasterPlaylist } from "./transcoder.service.js";

test("master playlist: header + one STREAM-INF + relative playlist per entry", () => {
  const playlist = buildMasterPlaylist([
    { height: 720, width: 1280, bitrate: 2_800_000 },
    { height: 480, width: 854, bitrate: 1_200_000 },
  ]);
  const lines = playlist.trim().split("\n");

  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#EXT-X-VERSION:3");
  assert.match(lines[2]!, /BANDWIDTH=2800000,RESOLUTION=1280x720/);
  assert.equal(lines[3], "720p/playlist.m3u8");
  assert.match(lines[4]!, /BANDWIDTH=1200000,RESOLUTION=854x480/);
  assert.equal(lines[5], "480p/playlist.m3u8");
});

test("master playlist: variant paths are relative (no leading slash / prefix)", () => {
  const playlist = buildMasterPlaylist([
    { height: 1080, width: 1920, bitrate: 5_000_000 },
  ]);
  assert.ok(playlist.includes("1080p/playlist.m3u8"));
  assert.ok(!playlist.includes("/1080p/playlist.m3u8"));
});

test("master playlist: empty entries still yields a valid header", () => {
  assert.equal(buildMasterPlaylist([]), "#EXTM3U\n#EXT-X-VERSION:3\n");
});
