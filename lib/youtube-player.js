'use strict';

// Shared by the server transformer and the trusted viewer. Never accept an
// arbitrary iframe URL or forward document/query credentials to a provider.
function youtubeSource(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let url;
  try { url = new URL(input); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) return null;
  const match = /^\/embed\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
  if (!match) return null;
  const clean = new URL(`https://${url.hostname.includes('youtube-nocookie') ? 'www.youtube-nocookie.com' : 'www.youtube.com'}/embed/${match[1]}`);
  const times = {};
  for (const key of ['start', 'end']) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1) return null;
    if (!values.length) continue;
    if (!/^\d{1,8}$/.test(values[0])) return null;
    times[key] = Number(values[0]);
    clean.searchParams.set(key, String(times[key]));
  }
  if (times.end !== undefined && times.end <= (times.start || 0)) return null;
  for (const key of ['cc_load_policy', 'rel']) {
    const value = url.searchParams.get(key);
    if (value === '0' || value === '1') clean.searchParams.set(key, value);
  }
  const watch = new URL('https://www.youtube.com/watch');
  watch.searchParams.set('v', match[1]);
  if (times.start) watch.searchParams.set('t', `${times.start}s`);
  return { src: clean.href, watch: watch.href };
}

function replaceYoutubeEmbeds(document) {
  let replaced = false;
  for (const frame of document.querySelectorAll('iframe[src]')) {
    const source = youtubeSource(frame.getAttribute('src'));
    if (!source || frame.hasAttribute('srcdoc')) continue;
    const link = document.createElement('a');
    link.href = source.watch;
    link.target = '_top';
    link.setAttribute('data-lookie-youtube', source.src);
    link.setAttribute('data-video-title', (frame.getAttribute('title') || 'YouTube video').slice(0, 200));
    link.textContent = `▶ Play ${link.getAttribute('data-video-title')}`;
    link.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:200px;padding:1rem;border:1px solid currentColor;border-radius:8px;text-align:center;font:inherit;color:inherit;background:transparent;';
    frame.replaceWith(link);
    replaced = true;
  }
  if (!replaced) return;
  const script = document.createElement('script');
  script.textContent = `(${embedVideoBridge.toString()})();`;
  document.body.appendChild(script);
}

function embedVideoBridge() {
  let ready = false;
  let trigger = null;
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || window.parent === window) return;
    if (event.data?.type === 'lookie-link:video-ready') ready = true;
    if (event.data?.type === 'lookie-link:video-closed' && trigger) trigger.focus();
  });
  document.addEventListener('click', function (event) {
    const link = event.target.closest?.('[data-lookie-youtube]');
    if (!link || !ready || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    trigger = link;
    window.parent.postMessage({ type: 'lookie-link:open-video', src: link.getAttribute('data-lookie-youtube'), title: link.getAttribute('data-video-title') }, '*');
  });
  if (window.parent !== window) window.parent.postMessage({ type: 'lookie-link:video-handshake' }, '*');
}

function viewerVideoRuntime(sourceParser) {
  const frame = document.querySelector('[data-embedded-html]');
  if (!frame) return;
  let dialog;
  function ready() {
    frame.contentWindow?.postMessage({ type: 'lookie-link:video-ready' }, '*');
  }
  function close() {
    if (!dialog) return;
    dialog.querySelector('iframe')?.remove(); // stop playback and network work
    if (dialog.open) dialog.close();
    frame.contentWindow?.postMessage({ type: 'lookie-link:video-closed' }, '*');
  }
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === 'lookie-link:video-handshake') { ready(); return; }
    if (event.data.type !== 'lookie-link:open-video' || !navigator.userActivation?.isActive) return;
    const source = sourceParser(event.data.src);
    if (!source) return;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.setAttribute('data-lookie-video-player', '');
      dialog.setAttribute('aria-label', 'Video player');
      dialog.style.cssText = 'box-sizing:border-box;width:min(960px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);padding:12px;border:1px solid #666;border-radius:10px;background:var(--bg,#111);color:var(--text,#eee);';
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;';
      const title = document.createElement('span'); title.dataset.videoHeading = '';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Close video'; button.addEventListener('click', close);
      bar.append(title, button); dialog.append(bar);
      const fallback = document.createElement('a'); fallback.dataset.videoFallback = ''; fallback.textContent = 'Open on YouTube'; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
      dialog.append(fallback);
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
      dialog.addEventListener('close', close);
      document.body.append(dialog);
    }
    dialog.querySelector('iframe')?.remove();
    const title = typeof event.data.title === 'string' ? event.data.title.slice(0, 200) : 'YouTube video';
    dialog.querySelector('[data-video-heading]').textContent = title;
    dialog.querySelector('[data-video-fallback]').href = source.watch;
    const player = document.createElement('iframe');
    player.title = title;
    player.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    player.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin'; // no path, source token or query leaves Lookie
    player.style.cssText = 'display:block;width:100%;aspect-ratio:16/9;min-height:200px;border:0;margin-bottom:10px;';
    const src = new URL(source.src); src.searchParams.set('autoplay', '1'); src.searchParams.set('playsinline', '1');
    player.src = src.href;
    dialog.insertBefore(player, dialog.querySelector('[data-video-fallback]'));
    if (!dialog.open) dialog.showModal();
  });
  frame.addEventListener('load', function () { close(); ready(); });
  window.addEventListener('pagehide', close);
}

function viewerVideoScript() {
  return `<script>(${viewerVideoRuntime.toString()})(${youtubeSource.toString()});</script>`;
}

module.exports = { youtubeSource, replaceYoutubeEmbeds, viewerVideoScript };
