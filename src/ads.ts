// 画面の下の Google AdSense 広告（Web 版だけ）。ID を入れるまでは何も表示しない（場所も取らない）。
// AdSense の管理画面で発行した「広告ユニットの ID」を ADSENSE_SLOT に入れると表示される。
// 発行者 ID（ca-pub-…）は公開される値なので、コードに置いてよい。
const ADSENSE_CLIENT: string = 'ca-pub-0807456611167337';
const ADSENSE_SLOT: string = '2269631493'; // 広告ユニットの ID（数字）。AdSense の「広告」→「広告ユニットごと」で作る

/** この時間たっても広告が届かなければ、あきらめて枠ごと消す */
const GIVE_UP_MS = 15_000;

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

/**
 * 下のメニューの真上に広告を置く。Android アプリ（Google Play 版の TWA。`.in-app`）の中では出さない
 * （AdSense はウェブサイト向けで、アプリ内の広告は AdMob の扱いのため）。markAndroidApp() の後に呼ぶ。
 * 広告の高さは --ad-h に入れ、シート・パネル・地図のボタンがその上に出るようにする。
 * 広告を読み出せない時（広告ブロッカー・オフラインなどでスクリプトが読めない、配信なし "unfilled"、
 * 一定時間たっても届かない、push の例外）は、空白の枠を残さず、広告の DOM ごと取り除く
 */
export function initAds(): void {
  if (!ADSENSE_CLIENT || !ADSENSE_SLOT) return;
  if (document.documentElement.classList.contains('in-app')) return;

  const banner = document.createElement('aside');
  banner.className = 'ad-banner';
  banner.setAttribute('aria-label', 'Advertisement');
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.dataset.adClient = ADSENSE_CLIENT;
  ins.dataset.adSlot = ADSENSE_SLOT;
  ins.dataset.adFormat = 'horizontal';
  banner.append(ins);
  document.body.append(banner);

  const root = document.documentElement.style;
  const sync = () => root.setProperty('--ad-h', `${banner.offsetHeight}px`);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
  observer?.observe(banner);

  let timer = 0;
  const giveUp = () => {
    observer?.disconnect();
    status.disconnect();
    window.clearTimeout(timer);
    banner.remove();
    root.removeProperty('--ad-h');
  };
  const check = () => {
    const s = ins.getAttribute('data-ad-status');
    if (s === 'unfilled') giveUp();
    else if (s === 'filled') window.clearTimeout(timer);
  };
  const status = new MutationObserver(check);
  status.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
  timer = window.setTimeout(() => {
    if (ins.getAttribute('data-ad-status') !== 'filled') giveUp();
  }, GIVE_UP_MS);

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT)}`;
  script.onerror = giveUp;
  document.head.append(script);
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (error) {
    console.error('[ads]', error);
    giveUp();
  }
}
