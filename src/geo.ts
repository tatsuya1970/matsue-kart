// 座標変換・共通ユーティリティ
// ワールド座標: x = 東 (m), z = 南 (m), y = 上 (m, 標高 T.P.)。原点は松江駅北口の駅前通り。
import courseJson from '../data/course.json';
import coursePathJson from '../data/course_path.json';

export const ORIGIN = courseJson.origin;
export const M_PER_LAT = 110950;
export const M_PER_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function llToXZ(lat: number, lon: number): [number, number] {
  return [(lon - ORIGIN.lon) * M_PER_LON, -(lat - ORIGIN.lat) * M_PER_LAT];
}

export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
  label?: boolean;
  /** 実在しない新設の高架道路区間 */
  elevated?: boolean;
}

export const WAYPOINTS: Waypoint[] = courseJson.waypoints;
export const ROAD_WIDTH: number = courseJson.roadWidth;
export const VIADUCT_HEIGHT: number = (courseJson as any).viaductHeight ?? 13;

/**
 * 走行線。tools/build_course.mjs が PLATEAU の道路面 (tran) の上を通る経路を
 * 探索して書き出したもの。2m 間隔の閉ループ。
 */
export interface CoursePath {
  points: [number, number][];
  elevated: number[];
  labels: { name: string; short?: string; en?: string; idx: number; label: boolean }[];
  length: number;
}
export const COURSE_PATH: CoursePath = coursePathJson as unknown as CoursePath;

/**
 * public/ 配下のアセット URL。
 * GitHub Pages のプロジェクトページのようにサブパス配信される場合があるので、
 * 絶対パスを直書きせず Vite の BASE_URL を基準にする。
 */
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, '');
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 決定的な疑似乱数 (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashInt(x: number, y: number) {
  let h = (Math.round(x * 10) * 73856093) ^ (Math.round(y * 10) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}
