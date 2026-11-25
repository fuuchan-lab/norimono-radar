// 船（Cloudflare Worker 経由で aisstream.io の AIS データから取得。船種を問わずすべて）
import { bearing, deadReckon, LIVE_API, movedKm } from './aircraft';
import type { LngLat } from './data';

export interface Ship {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  /** 速力 kn */
  sog: number | null;
  /** 船首の向き（度）。航行中は進んでいる向き（COG）、停泊中は船首方位 */
  heading: number | null;
  moving: boolean;
  type: number;
  dest: string;
  /** 全長 m */
  length: number | null;
  /** この位置を受信した時刻（ms） */
  at: number;
}

type Row = [number, string, number, number, number | null, number | null, number | null, number, string, number, number | null];

/** 止まっているとみなす速力（kn） */
const MOORED_KNOTS = 1;

export async function fetchShips(prev: Ship[]): Promise<Ship[]> {
  const res = await fetch(`${LIVE_API}/ships`);
  if (!res.ok) throw new Error(`ships ${res.status}`);
  return parseShips((await res.json()) as { now: number; ships: Row[] }, prev);
}

/** 中継サーバー（/ships）の応答を、表示用にする */
function parseShips(data: { now: number; ships: Row[] }, prev: Ship[]): Ship[] {
  const before = new Map(prev.map((s) => [s.mmsi, s]));
  return data.ships.map(([mmsi, name, lat, lon, sog, cog, hdg, type, dest, age, length]) => {
    const moving = (sog ?? 0) >= MOORED_KNOTS;
    const p = before.get(mmsi);
    let heading = moving ? cog ?? hdg : hdg ?? cog;
    if (heading === null && p && movedKm([p.lon, p.lat], [lon, lat]) > 0.05) heading = bearing([p.lon, p.lat], [lon, lat]);
    if (heading === null && p) heading = p.heading;
    // AIS は名前・行先の空いた部分を @ で埋めて送ってくる
    const clean = (v: string) => (v ?? '').replace(/@+/g, ' ').trim();
    return { mmsi, name: clean(name), lat, lon, sog, heading, moving, type, dest: clean(dest), length, at: data.now - age * 1000 };
  });
}

/** 航行中は速力と針路で進めた位置、停泊中は受信位置 */
export const shipAt = (s: Ship, ms: number): LngLat => (s.moving ? deadReckon(s.lon, s.lat, s.sog, s.heading, ms - s.at) : [s.lon, s.lat]);

export const shipLabel = (s: Ship) => s.name || `MMSI ${s.mmsi}`;

/** 貨物船（AIS の船種 70〜79）とタンカー（80〜89） */
export const isCargo = (type: number) => type >= 70 && type <= 89;

/** AIS の船種の分類（画面の表示名は i18n の shipTypes） */
export type ShipKind = 'passenger' | 'cargo' | 'tanker' | 'fishing' | 'tug' | 'pleasure' | 'other' | 'unknown';
export function shipKind(type: number): ShipKind {
  if (type >= 60 && type <= 69) return 'passenger';
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 80 && type <= 89) return 'tanker';
  if (type === 30) return 'fishing';
  if (type === 31 || type === 32 || type === 52) return 'tug';
  if (type === 36 || type === 37) return 'pleasure';
  if (!type) return 'unknown';
  return 'other';
}
