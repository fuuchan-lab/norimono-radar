// 日本近海の船（船種を問わない）を aisstream.io の AIS データから集める。
// 位置と船種は別のメッセージで届く（船種は約6分おき）ため、接続を保ったまま貯めておく。

import { FlightLog } from './flights.js';

const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
// [[南西の緯度, 経度], [北東の緯度, 経度]]: 日本の排他的経済水域を囲む範囲（細かい判定はフロントエンドで行う）
const BOX = [[17.0, 122.0], [48.0, 158.0]];
const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const STALE_MS = 15 * 60 * 1000;
// 船名・船種を保存しておく上限（1 つの値は 128KB までなので 1,000 隻ずつに分ける）
const STATICS_MAX = 5000;
const STATICS_CHUNK = 1000;

export class ShipStore {
  /** MMSI -> 位置 */
  positions = new Map();
  /** MMSI -> 船名・船種など（旅客船以外も一時的に持つ） */
  statics = new Map();
  /** 状態確認用: 受信したメッセージの種類ごとの件数など */
  stats = { messages: 0, byType: {}, lastError: '' };

  handle(msg) {
    this.stats.messages++;
    if (msg.error) this.stats.lastError = String(msg.error);
    const kind = msg.MessageType ?? 'unknown';
    this.stats.byType[kind] = (this.stats.byType[kind] ?? 0) + 1;
    const mmsi = msg.MetaData?.MMSI;
    if (!mmsi) return;
    const type = msg.MessageType;
    const body = msg.Message?.[type];
    if (!body) return;
    if (type === 'PositionReport' || type === 'StandardClassBPositionReport' || type === 'ExtendedClassBPositionReport') {
      const { Latitude: lat, Longitude: lon } = body;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      this.positions.set(mmsi, {
        lat, lon, sog: body.Sog, cog: body.Cog, hdg: body.TrueHeading, at: Date.now(),
        name: (msg.MetaData.ShipName ?? '').trim(),
      });
      if (type === 'ExtendedClassBPositionReport') this.merge(mmsi, { type: body.Type, name: body.Name });
    } else if (type === 'ShipStaticData') {
      const d = body.Dimension ?? {};
      this.merge(mmsi, { name: body.Name, type: body.Type, dest: body.Destination, len: (d.A ?? 0) + (d.B ?? 0) });
    } else if (type === 'StaticDataReport') {
      if (body.ReportA?.Valid) this.merge(mmsi, { name: body.ReportA.Name });
      if (body.ReportB?.Valid) this.merge(mmsi, { type: body.ReportB.ShipType });
    }
  }

  merge(mmsi, info) {
    const cur = this.statics.get(mmsi) ?? {};
    for (const [k, v] of Object.entries(info)) {
      if (v === undefined || v === null || v === '') continue;
      cur[k] = typeof v === 'string' ? v.trim() : v;
    }
    this.statics.set(mmsi, cur);
  }

  /** すべての船。[MMSI, 船名, 緯度, 経度, 速力kn, 針路, 船首方位, 船種（不明は 0）, 行先, 位置の古さ秒, 全長m] */
  all() {
    return this.inBox({ s: BOX[0][0], w: BOX[0][1], n: BOX[1][0], e: BOX[1][1] });
  }

  /**
   * 範囲内のすべての船（船種を問わない）。行の形は all() と同じ。船種が不明なら 0（海ログ（OceanLog）でも使う）
   * box: { s, w, n, e }
   */
  inBox(box) {
    const now = Date.now();
    const out = [];
    for (const [mmsi, p] of this.positions) {
      if (now - p.at > STALE_MS) {
        this.positions.delete(mmsi);
        continue;
      }
      if (p.lat < box.s || p.lat > box.n || p.lon < box.w || p.lon > box.e) continue;
      const s = this.statics.get(mmsi);
      out.push([
        mmsi, s?.name || p.name || '', round(p.lat, 5), round(p.lon, 5), p.sog ?? null,
        p.cog != null && p.cog < 360 ? p.cog : null,
        p.hdg != null && p.hdg < 360 ? p.hdg : null,
        s?.type ?? 0, s?.dest ?? '', Math.round((now - p.at) / 1000), s?.len || null,
      ]);
    }
    return out;
  }

  /** 保存用: 船種が分かっている船の船名・船種・全長（再起動後すぐ貨物船かどうかを分けられるように）。新しく覚えたものを優先 */
  savedStatics() {
    const rows = [...this.statics].filter(([, s]) => s.type).map(([mmsi, s]) => [mmsi, { name: s.name, type: s.type, len: s.len }]);
    return rows.slice(-STATICS_MAX);
  }
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** 海ログの範囲の広さの上限（度）。約 110km 四方 */
export const MAX_BOX_DEG = 1;

/** "南,西,北,東"（度）を { s, w, n, e } に。0.1 度単位で、広すぎる・おかしい値は null */
export function parseBox(text) {
  const v = String(text ?? '').split(',').map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  const [s, w, n, e] = v;
  if (s >= n || w >= e || n - s > MAX_BOX_DEG + 1e-9 || e - w > MAX_BOX_DEG + 1e-9) return null;
  if (s < -90 || n > 90 || w < -180 || e > 180) return null;
  if (v.some((x) => Math.abs(x * 10 - Math.round(x * 10)) > 1e-6)) return null;
  return { s, w, n, e };
}

const decoder = new TextDecoder();
/** メッセージを文字列にする（文字列・ArrayBuffer・型付き配列・Blob のどれでも） */
async function textOf(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return decoder.decode(data);
  if (typeof data?.arrayBuffer === 'function') return decoder.decode(await data.arrayBuffer());
  return String(data);
}

/** Cloudflare Workers では fetch の Upgrade で接続する（new WebSocket では外向きに繋がらない） */
async function open(url) {
  if (typeof WebSocketPair === 'undefined') {
    // Node.js（test/run-local.mjs）
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return ws;
  }
  const res = await fetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' } });
  if (!res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
  res.webSocket.accept();
  return res.webSocket;
}

export async function connect(apiKey, store, onClose) {
  store.stats.opened = false;
  const ws = await open(AIS_URL);
  store.stats.opened = true;
  // 接続後すぐ（3秒以内）に購読内容を送る
  ws.send(JSON.stringify({ APIKey: apiKey, BoundingBoxes: [BOX], FilterMessageTypes: MESSAGE_TYPES }));
  ws.addEventListener('message', async (e) => {
    try {
      store.handle(JSON.parse(await textOf(e.data)));
    } catch (err) {
      store.stats.lastError = `parse: ${err}`;
    }
  });
  ws.addEventListener('close', (e) => {
    store.stats.lastClose = `${e.code} ${e.reason ?? ''}`.trim();
    onClose();
  });
  ws.addEventListener('error', (e) => {
    store.stats.lastError = `ws: ${e.message ?? e.type}`;
    onClose();
  });
  return ws;
}

// 船種は約6分おきにしか届かず、日本近海では届かないことも多いので、誰も見ていなくても接続を保って
// 船名・船種を貯めておく（無料枠: 128MB × 24時間 ≒ 10,800 GB 秒/日。上限は 13,000）
const ALARM_MS = 30 * 1000;
// 便の観測（flights.js）と船名・船種は、書き込みの回数を抑えるため 5 分ごとにまとめて保存する（1 回の put は 128 件まで）
const FLIGHT_SAVE_MS = 5 * 60 * 1000;
const STATICS_SAVE_MS = 5 * 60 * 1000;

/** AIS への接続を保つ Durable Object（日本全体で1つ）。空港の発着のふだんの時刻（flights.js）もここで覚える */
export class ShipTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = new ShipStore();
    this.flights = new FlightLog();
    this.flightsSavedAt = Date.now();
    this.staticsSavedAt = Date.now();
    this.ws = null;
    state.blockConcurrencyWhile(async () => {
      // 以前は旅客船だけを 'statics' に保存していた
      const legacy = (await state.storage.get('statics')) ?? [];
      const chunks = [...(await state.storage.list({ prefix: 'st:' })).values()];
      this.store.statics = new Map([...legacy, ...chunks.flat()]);
      this.flights.load(await state.storage.list({ prefix: 'f:' }));
    });
  }

  async ensureConnected() {
    if (!this.env.AISSTREAM_API_KEY || this.connecting) return;
    if (this.ws && this.ws.readyState <= 1) return;
    this.connecting = true;
    try {
      this.ws = await connect(this.env.AISSTREAM_API_KEY, this.store, () => {
        this.ws = null;
      });
    } catch (err) {
      this.store.stats.lastError = `connect: ${err}`;
      this.ws = null;
    } finally {
      this.connecting = false;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + ALARM_MS);
    if (url.pathname === '/flights/observe') {
      const { now, obs } = await request.json();
      this.flights.observe(now, obs);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/airport') {
      return Response.json(this.flights.airport(url.searchParams.get('code') ?? '', Date.now()));
    }
    await this.ensureConnected();
    if (url.pathname === '/vessels') {
      const box = parseBox(url.searchParams.get('bbox'));
      if (!box) return Response.json({ error: 'bad bbox' }, { status: 400 });
      return Response.json({ now: Date.now(), connected: !!this.ws, ships: this.store.inBox(box) });
    }
    const ships = this.store.all();
    return Response.json({
      now: Date.now(),
      connected: !!this.ws,
      // 状態確認用（映らないときの切り分け）
      stats: { ...this.store.stats, positions: this.store.positions.size, statics: this.store.statics.size, readyState: this.ws?.readyState ?? null },
      ships,
    });
  }

  async alarm() {
    if (Date.now() - this.staticsSavedAt > STATICS_SAVE_MS) await this.saveStatics();
    if (Date.now() - this.flightsSavedAt > FLIGHT_SAVE_MS) await this.saveFlights();
    await this.ensureConnected();
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async saveStatics() {
    const rows = this.store.savedStatics();
    const chunks = {};
    for (let i = 0; i * STATICS_CHUNK < STATICS_MAX; i++) chunks[`st:${i}`] = rows.slice(i * STATICS_CHUNK, (i + 1) * STATICS_CHUNK);
    await this.state.storage.put(chunks);
    await this.state.storage.delete('statics');
    this.staticsSavedAt = Date.now();
  }

  async saveFlights() {
    const f = this.flights;
    f.prune(Date.now());
    const keys = [...f.dirty];
    for (let i = 0; i < keys.length; i += 128) {
      await this.state.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [`f:${k}`, f.records.get(k)])));
    }
    const removed = [...f.removed].map((k) => `f:${k}`);
    for (let i = 0; i < removed.length; i += 128) await this.state.storage.delete(removed.slice(i, i + 128));
    f.dirty.clear();
    f.removed.clear();
    this.flightsSavedAt = Date.now();
  }
}
