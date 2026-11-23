/**
 * 掛け合いのセリフを、ローカルの VOICEVOX で音声ファイル(voice/*.mp3)に書き出す。
 * 公開先(GitHub Pages など)では VOICEVOX に接続できないため、事前に収録しておく。
 *
 * 使い方: VOICEVOX を起動した状態で、このフォルダの1つ上で
 *   node tools/gen_voice.js
 * 必要なもの: Node.js 18 以上、ffmpeg(PATH が通っていること)
 *
 * セリフの文・話者・感情・声の調整は index.html から直接読み取るので、
 * セリフを書き換えたらもう一度実行するだけでよい(変わったセリフだけ作り直す)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'voice');
const VV = 'http://127.0.0.1:50021';

/** index.html のスクリプトを最小限の DOM の代わりで実行し、読み上げる文の一覧を受け取る */
function loadLines() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const el = () => ({
    innerHTML: '', textContent: '', value: '', hidden: false, children: [], dataset: {},
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, scrollIntoView() {}, querySelectorAll() { return []; },
  });
  const els = {};
  let result = null;
  const sandbox = {
    document: { getElementById: id => els[id] || (els[id] = el()), addEventListener() {}, querySelector: el },
    window: { __EXPORT_VOICE: r => { result = r; } },
    location: { protocol: 'http:', hostname: 'export', search: '' },
    matchMedia: () => ({ matches: false }), Image: function () {},
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  };
  new Function(...Object.keys(sandbox), js)(...Object.values(sandbox));
  if (!result) throw new Error('index.html から セリフ一覧を取得できませんでした');
  return result;
}

/** 感情ごとの声スタイルを、ページと同じ優先順位で選ぶ */
async function pickStyles(VVSPK, EMOV) {
  const list = await (await fetch(VV + '/speakers')).json();
  const st = {};
  for (const k in VVSPK) {
    const sp = list.find(x => x.name === VVSPK[k].name);
    if (!sp) throw new Error(VVSPK[k].name + ' が VOICEVOX に見つかりません');
    st[k] = {};
    for (const e in EMOV) st[k][e] = (EMOV[e].pref.map(p => sp.styles.find(s => s.name === p)).find(Boolean) || sp.styles[0]).id;
  }
  return st;
}

async function main() {
  let ver;
  try { ver = await (await fetch(VV + '/version')).json(); }
  catch (e) { console.error('VOICEVOX に接続できません。VOICEVOX を起動してから実行してください。'); process.exit(1); }

  const { lines, EMOV, VVSPK } = loadLines();
  const styles = await pickStyles(VVSPK, EMOV);
  fs.mkdirSync(OUT, { recursive: true });
  const mfPath = path.join(OUT, 'manifest.json');
  const old = fs.existsSync(mfPath) ? JSON.parse(fs.readFileSync(mfPath, 'utf8')).lines : {};
  const tmp = path.join(OUT, '_tmp.wav');
  const man = {};
  let made = 0;

  for (const [i, l] of lines.entries()) {
    const a = EMOV[l.emo].adj, S = VVSPK[l.s], id = styles[l.s][l.emo];
    const q = { speedScale: S.speed * (a.s || 1), pitchScale: a.p || 0, intonationScale: S.inton * (a.i || 1), prePhonemeLength: 0.05, postPhonemeLength: 0.12 };
    const f = l.id + '.mp3';
    const sig = JSON.stringify([id, q]);
    // 文と声の設定が前回と同じで、ファイルもあれば作り直さない
    if (old[l.id] && old[l.id].t === l.t && old[l.id].sig === sig && fs.existsSync(path.join(OUT, f))) {
      man[l.id] = old[l.id];
      continue;
    }
    const r1 = await fetch(`${VV}/audio_query?text=${encodeURIComponent(l.t)}&speaker=${id}`, { method: 'POST' });
    if (!r1.ok) throw new Error('audio_query ' + r1.status + ': ' + l.t);
    const aq = Object.assign(await r1.json(), q);
    const r2 = await fetch(`${VV}/synthesis?speaker=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aq) });
    if (!r2.ok) throw new Error('synthesis ' + r2.status + ': ' + l.t);
    fs.writeFileSync(tmp, Buffer.from(await r2.arrayBuffer()));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', '24000', '-b:a', '64k', path.join(OUT, f)]);
    man[l.id] = { f, t: l.t, sig };
    made++;
    process.stdout.write(`\r${i + 1}/${lines.length} 作成中…`);
  }
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  // 使われなくなった古い音声ファイルを片付ける
  const keep = new Set(Object.values(man).map(e => e.f));
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.mp3') && !keep.has(f)) fs.unlinkSync(path.join(OUT, f));
  fs.writeFileSync(mfPath, JSON.stringify({ engine: 'VOICEVOX ' + ver, lines: man }, null, 1));
  console.log(`\n完了:${lines.length} セリフ(新しく作成 ${made})→ voice/`);
}
main().catch(e => { console.error('\n' + e.message); process.exit(1); });
