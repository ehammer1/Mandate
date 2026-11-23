// Campaign and proposal videos: links checked, YouTube recognized for tap-to-play, seals shown
// as pending until Testimonia launches, nothing unsafe rendered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeId, platformOf, readVideos, videosHtml } from '../app/src/videos.js';

const root = (values) => ({ querySelector: (sel) => {
  const m = sel.match(/data-[a-z]+-vid-([a-z]+)="(\d)"/);
  return m ? { value: values[`${m[1]}${m[2]}`] ?? '' } : null;
} });

test('YouTube links of every shape give the video id; other platforms are named', () => {
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ']) assert.equal(youtubeId(u), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(platformOf('https://www.tiktok.com/@a/video/1'), 'TikTok');
  assert.equal(platformOf('https://x.com/a/status/1'), 'X');
});

test('only https links; a Testimonia seal is kept with its original file and links to Testimonia', () => {
  assert.throws(() => readVideos(root({ url0: 'http://youtube.com/x' }), 'pet'), /https/);
  assert.throws(() => readVideos(root({ url0: 'https://youtu.be/abcdefg', orig0: 'javascript:alert(1)' }), 'pet'), /original file/);
  assert.equal(readVideos(root({}), 'pet'), undefined);
  const rec = JSON.stringify({ format: 'attest-record/1', sealDigest: '0x' + '2'.repeat(64), manifest: { meta: { keyId: 'e'.repeat(64) }, seal: { fileHash: 'f'.repeat(64) } } });
  assert.throws(() => readVideos(root({ url0: 'https://youtu.be/dQw4w9WgXcQ', seal0: 'TS1.abc' }), 'pet'), /not a Testimonia seal/);
  const v = readVideos(root({ url0: 'https://youtu.be/dQw4w9WgXcQ', title0: 'Why we need a crosswalk', seal0: rec, orig0: 'ipfs://bafyexample', url1: 'https://www.tiktok.com/@a/video/1' }), 'pet');
  assert.equal(v.length, 2);
  assert.deepEqual([v[0].seal.by, v[0].seal.kind, v[0].seal.keyId, v[0].seal.sealDigest, v[0].seal.originalFile], ['testimonia', 'recording', 'e'.repeat(64), '0x' + '2'.repeat(64), 'ipfs://bafyexample']);
  const html = videosHtml(v);
  assert.match(html, /data-yt="dQw4w9WgXcQ"/); // tap to play; nothing loads before
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /Sealed by Testimonia: <a href="https:\/\/ehammer1\.github\.io\/testimonia\/#proof=/);
  assert.match(html, /Not sealed: authenticity not checked/);
  assert.match(html, /https:\/\/ipfs\.io\/ipfs\/bafyexample/);
  assert.equal(videosHtml([{ url: 'javascript:alert(1)' }]), '');
  assert.doesNotMatch(videosHtml([{ url: 'https://youtu.be/dQw4w9WgXcQ', title: '<img onerror=x>' }]), /<img/);
});
