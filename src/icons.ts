// 地図用アイコン（SVG を画像にして MapLibre に登録する）
import type { Map as MLMap } from 'maplibre-gl';

// 白い縁取り: 0 = 通常 / 1 = 登録した（トラッキング中の）もの。少し太くする
type Outline = 0 | 1;

// 新幹線の先頭車を横から見たピクトグラム
const station = (o: Outline) => `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <rect x="1.5" y="1.5" width="25" height="25" rx="6" fill="#0b1f3a" stroke="#fff" stroke-width="${[2, 3.2][o]}"/>
  <path d="M5 17.5h13.5c3 0 5-1.1 5-2.4 0-1.2-1.9-2-4.7-2.9l-4.3-1.5c-1.2-.4-2.3-.6-3.5-.6H5z" fill="#fff"/>
  <path d="M7 12.4h3v1.8H7zM11.2 12.4h3v1.8h-3z" fill="#0b1f3a"/>
  <path d="M15.6 12.3l3 1.1c.4.2.2.8-.3.8h-2.7z" fill="#0b1f3a"/>
  <rect x="5" y="19.5" width="18" height="1.6" rx=".8" fill="#fff"/>
</svg>`;

const AIRPORT = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="10.5" fill="#5b6b7f" stroke="#fff" stroke-width="2"/>
  <g transform="translate(12 12) rotate(45) scale(.62) translate(-12 -12)">
    <path fill="#fff" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
  </g>
</svg>`;

// 列車: 進行方向（上）を向いた細い三角形
const train = (color: string, o: Outline) => `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="34" viewBox="0 0 18 34">
  <path d="M9 3.5L15 31H3z" fill="${color}" stroke="#fff" stroke-width="${[3.2, 5.6][o]}" stroke-linejoin="round" paint-order="stroke"/>
</svg>`;

// 飛行機: 機首が上（進行方向）。国内線は黄色、国際線はピンク
export const PLANE_COLORS = { domestic: '#ffc400', international: '#ff4fa3' };
const plane = (color: string, o: Outline) => `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="-1 -1 26 26">
  <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"
    transform="translate(.5 0)" fill="${color}" stroke="#fff" stroke-width="${[2.6, 4.6][o]}" stroke-linejoin="round" paint-order="stroke"/>
</svg>`;

// 船: 上から見た船体（船首が上）。貨物船（タンカーを含む）は茶色、それ以外は濃い水色
export const SHIP_COLOR = '#0088cc';
export const CARGO_COLOR = '#8a6334';
const ship = (color: string, o: Outline) => `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="38" viewBox="-1 -1 18 38">
  <path d="M8 1.5C11.6 6 13.5 10.5 13.5 15.5V31.5Q13.5 34.5 10.5 34.5H5.5Q2.5 34.5 2.5 31.5V15.5C2.5 10.5 4.4 6 8 1.5Z"
    fill="${color}" stroke="#fff" stroke-width="${[3, 5][o]}" stroke-linejoin="round" paint-order="stroke"/>
  <rect x="5" y="17" width="6" height="9" rx="1.2" fill="#fff" fill-opacity=".9"/>
  <path d="M8 6.5L10 11H6z" fill="#fff" fill-opacity=".75"/>
</svg>`;

async function svgImage(svg: string, scale: number): Promise<HTMLImageElement> {
  const w = Number(/width="(\d+)"/.exec(svg)![1]) * scale;
  const h = Number(/height="(\d+)"/.exec(svg)![1]) * scale;
  const img = new Image(w, h);
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return img;
}

/**
 * 駅・空港・飛行機・船（貨物船とそれ以外）と、路線ごとの列車アイコン（train-<路線id>）を登録する。
 * 登録した（トラッキング中の）ものは縁取りを太くした「-fav」付きの名前で別に登録する
 */
export async function addIcons(map: MLMap, lines: { id: string; color: string }[]) {
  const ratio = 2;
  const images: [string, string][] = [['airport', AIRPORT]];
  for (const o of [0, 1] as const) {
    const fav = o ? '-fav' : '';
    images.push(
      [`station${fav}`, station(o)],
      [`plane-domestic${fav}`, plane(PLANE_COLORS.domestic, o)],
      [`plane-international${fav}`, plane(PLANE_COLORS.international, o)],
      [`ship${fav}`, ship(SHIP_COLOR, o)],
      [`cargo${fav}`, ship(CARGO_COLOR, o)],
      ...lines.map((l): [string, string] => [`train-${l.id}${fav}`, train(l.color, o)]),
    );
  }
  await Promise.all(
    images.map(async ([name, svg]) => map.addImage(name, await svgImage(svg, ratio), { pixelRatio: ratio })),
  );
}
