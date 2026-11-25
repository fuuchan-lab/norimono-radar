// Google アカウントでのログインと、利用者の登録内容（トラッキング中の列車・飛行機・船、お気に入りの駅）の保存。
// ログインは Google Identity Services のトークン方式で、ブラウザだけで完結する（LeadLog と同じ）。
// 保存先は利用者の Google ドライブのアプリ専用領域（appDataFolder）の user.json。
// 利用者のドライブの一覧には出ず、このアプリからしか読み書きできない

/** OAuth クライアント ID（公開してよい値）。未設定ならログイン機能を出さない */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.profile`;
const DATA_FILE = 'user.json';

export type FavKind = 'train' | 'aircraft' | 'ship' | 'station';
/** id: 列車名＋号数 / 便名やコールサイン / MMSI / 駅名。label は一覧に出す名前 */
export interface Fav { id: string; label: string }
/** 設定（ログイン中は、変えたものがほかの端末でも既定になる）。未設定の項目は端末の設定のまま */
export interface Settings {
  lang?: 'ja' | 'en';
  theme?: 'auto' | 'light' | 'dark';
  domestic?: boolean;
  international?: boolean;
  ships?: boolean;
  cargo?: boolean;
  rain?: boolean;
}
export interface UserData { version: 1; favorites: Record<FavKind, Fav[]>; settings: Settings }
export interface Account { name: string; picture: string }

const emptyData = (): UserData => ({ version: 1, favorites: { train: [], aircraft: [], ship: [], station: [] }, settings: {} });

/**
 * 保存した内容を今の形にそろえる。以前登録できた API キー（aisstream.io・AeroDataBox）は使わなくなったので読み込まない
 * （次の保存でドライブからも消える）
 */
function clean(d: Partial<UserData> & { keys?: unknown }): UserData {
  const { keys: _old, ...rest } = d;
  return { ...emptyData(), ...rest, favorites: { ...emptyData().favorites, ...rest.favorites }, settings: { ...rest.settings } };
}

const KEY = { token: 'auth.token', account: 'auth.account', data: 'user.data' };
function load<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function store(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても、ドライブには保存される
  }
}

let token = load<{ value: string; expires: number }>(KEY.token);
const cachedAccount = load<Account>(KEY.account);

/** 画面に出す状態。account が null ならゲスト（閲覧のみ） */
export const user = {
  account: cachedAccount,
  data: clean((cachedAccount && load<UserData>(KEY.data)) || {}),
  busy: false,
  error: '',
};

const listeners = new Set<() => void>();
export const onUserChange = (f: () => void) => listeners.add(f);
const emit = () => listeners.forEach((f) => f());

// ---- Google Identity Services ----
interface TokenResponse { access_token?: string; expires_in?: string | number; error?: string; error_description?: string }
interface Oauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (res: TokenResponse) => void;
    error_callback?: (err: { type: string }) => void;
  }): { requestAccessToken(options?: { prompt?: string }): void };
  hasGrantedAllScopes(res: TokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
}
declare global {
  interface Window { google?: { accounts?: { oauth2?: Oauth2 } } }
}

let gis: Promise<void> | null = null;
/** ログインのポップアップはタップの直後に開く必要があるので、ログインしそうなときに先に読み込んでおく */
export function preloadGoogle(): Promise<void> {
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = null;
      reject(new Error('Google のログイン機能を読み込めませんでした'));
    };
    document.head.appendChild(s);
  });
  return gis;
}

/** ポップアップでアクセストークンを取る。タップの処理の中で、await より前に呼ぶ */
function requestToken(prompt: '' | 'consent' | 'select_account'): Promise<string> {
  return new Promise((resolve, reject) => {
    const g = window.google?.accounts?.oauth2;
    if (!g) {
      preloadGoogle().catch(() => {});
      reject(new Error('ログインの準備中です。もう一度押してください'));
      return;
    }
    let settled = false;
    const done = (f: () => void) => {
      if (settled) return;
      settled = true;
      f();
    };
    g.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (res) => done(() => {
        if (res.error || !res.access_token) return reject(new Error(res.error_description || 'ログインできませんでした'));
        if (!g.hasGrantedAllScopes(res, DRIVE_SCOPE)) {
          return reject(new Error('Google ドライブへの保存が許可されていません。ログインし直して、ドライブのチェックを入れてください'));
        }
        token = { value: res.access_token, expires: Date.now() + (Number(res.expires_in ?? 3600) - 60) * 1000 };
        store(KEY.token, token);
        resolve(token.value);
      }),
      error_callback: (err) => {
        // ポップアップを閉じた通知がトークンより先に届くことがあるので少し待つ
        const delay = err.type === 'popup_closed' ? 8000 : 0;
        setTimeout(() => done(() => reject(new Error(err.type === 'popup_failed_to_open'
          ? 'ログイン画面を開けませんでした。ポップアップを許可してください'
          : 'ログインが中断されました'))), delay);
      },
    }).requestAccessToken({ prompt });
  });
}

const tokenValid = () => !!token && token.expires > Date.now();
const validToken = () => (tokenValid() ? Promise.resolve(token!.value) : requestToken(''));

async function api(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const t = await validToken();
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${t}` } });
  if (res.status === 401 && retry) {
    token = null;
    return api(url, init, false);
  }
  if (!res.ok) throw new Error(`Google ドライブ ${res.status}`);
  return res;
}

// ---- ドライブの user.json ----
let fileId: string | null = null;

async function readRemote(): Promise<UserData | null> {
  const q = encodeURIComponent(`name='${DATA_FILE}'`);
  const list = (await (await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json()) as { files: { id: string }[] };
  fileId = list.files[0]?.id ?? null;
  if (!fileId) return null;
  const d = (await (await api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).json()) as Partial<UserData>;
  return clean(d);
}

async function writeRemote(d: UserData) {
  const body = JSON.stringify(d);
  if (fileId) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return;
  }
  const b = `sl${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name: DATA_FILE, parents: ['appDataFolder'] });
  const res = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`,
  });
  fileId = ((await res.json()) as { id: string }).id;
}

function setData(d: UserData) {
  user.data = d;
  store(KEY.data, d);
}

/** 処理中の表示とエラーをまとめて扱う */
async function run(task: () => Promise<void>) {
  user.busy = true;
  user.error = '';
  emit();
  try {
    await task();
  } catch (err) {
    user.error = err instanceof Error ? err.message : String(err);
  } finally {
    user.busy = false;
    emit();
  }
}

// ---- 公開する操作 ----

/** ログイン（タップの処理から呼ぶ） */
export function signIn(switchAccount = false) {
  const tokenPromise = requestToken(switchAccount ? 'select_account' : 'consent');
  return run(async () => {
    await tokenPromise;
    const info = (await (await api('https://www.googleapis.com/oauth2/v2/userinfo')).json()) as { name?: string; picture?: string };
    user.account = { name: info.name ?? 'Google アカウント', picture: info.picture ?? '' };
    store(KEY.account, user.account);
    fileId = null;
    setData((await readRemote()) ?? emptyData());
  });
}

export function signOut() {
  if (token) window.google?.accounts?.oauth2?.revoke(token.value);
  token = null;
  fileId = null;
  user.account = null;
  user.error = '';
  user.data = emptyData();
  for (const k of Object.values(KEY)) store(k, null);
  emit();
}

/** 起動時・画面に戻ったとき: 他の端末で変えた内容を取り込む（トークンが切れていればポップアップは出さず、手元の内容のまま） */
export function refresh() {
  if (!user.account || !GOOGLE_CLIENT_ID) return;
  preloadGoogle().catch(() => {});
  if (!tokenValid()) return;
  run(async () => {
    const d = await readRemote();
    if (d) setData(d);
  });
}

export const isFav = (kind: FavKind, id: string) => user.data.favorites[kind].some((f) => f.id === id);

let saving: Promise<void> = Promise.resolve();
/** 登録・解除してドライブに保存する（タップの処理から呼ぶ）。ゲストなら false */
export function toggleFav(kind: FavKind, fav: Fav): boolean {
  if (!user.account) return false;
  const list = user.data.favorites[kind];
  const next = isFav(kind, fav.id) ? list.filter((f) => f.id !== fav.id) : [...list, fav];
  setData({ ...user.data, favorites: { ...user.data.favorites, [kind]: next } });
  emit();
  persist();
  return true;
}

/** 設定を変えたとき（タップの処理から呼ぶ）。ログイン中だけ Google ドライブに保存する。ゲストなら何もしない */
export function saveSettings(patch: Settings): boolean {
  if (!user.account) return false;
  setData({ ...user.data, settings: { ...user.data.settings, ...patch } });
  emit();
  persist();
  return true;
}


function persist() {
  // トークンが切れていたらここでポップアップを開く（タップの直後でないと開けない）
  const ready = validToken();
  ready.catch(() => {}); // 失敗は下の run で表示する
  saving = saving.then(() => run(async () => {
    await ready;
    if (!fileId) await readRemote();
    await writeRemote(user.data);
  }));
}
