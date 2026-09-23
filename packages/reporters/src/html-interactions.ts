export const REPORT_JS = `
(() => {
  const root = document.documentElement;
  const theme = document.querySelector('[data-theme-toggle]');
  try {
    const stored = localStorage.getItem('sedum-theme');
    if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;
  } catch {}
  theme?.addEventListener('click', () => {
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.dataset.theme = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('sedum-theme', root.dataset.theme); } catch {}
  });

  const filters = document.querySelector('.filters');
  filters?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.filter) {
      const filter = button.dataset.filter;
      filters.querySelectorAll('[data-filter]').forEach(b => {
        if (b === button) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
      document.querySelectorAll('.test').forEach(section => {
        const show = filter === 'all' || section.dataset.status === filter;
        section.hidden = !show;
        const body = section.querySelector('.test-body');
        if (body) body.open = filter === 'all' ? section.dataset.status === 'failed' : show;
      });
    }
    if (button.dataset.act === 'expand-all') {
      const open = button.getAttribute('aria-pressed') !== 'true';
      document.querySelectorAll('.test:not([hidden]) .test-body').forEach(body => { body.open = open; });
      button.setAttribute('aria-pressed', String(open));
      button.textContent = open ? 'collapse all' : 'expand all';
    }
  });

  let printState;
  addEventListener('beforeprint', () => {
    printState = {
      sections: [...document.querySelectorAll('.test')].map(node => [node, node.hidden]),
      details: [...document.querySelectorAll('details')].map(node => [node, node.open])
    };
    printState.sections.forEach(([node]) => { node.hidden = false; });
    printState.details.forEach(([node]) => { node.open = true; });
  });
  addEventListener('afterprint', () => {
    if (!printState) return;
    printState.sections.forEach(([node, hidden]) => { node.hidden = hidden; });
    printState.details.forEach(([node, open]) => { node.open = open; });
    printState = undefined;
  });

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.replay').forEach(fig => {
    const script = fig.querySelector('script.frames');
    let frames;
    try { frames = JSON.parse(script.textContent); } catch { return; }
    if (!frames.length) return;
    const layers = fig.querySelectorAll('.layer');
    const mark = fig.querySelector('.mark');
    const placeholder = fig.querySelector('.frame-placeholder');
    const counter = fig.querySelector('.counter');
    const label = fig.querySelector('.frame-label');
    const playButton = fig.querySelector('[data-act="play"]');
    const frameButtons = [...fig.querySelectorAll('.fr')];
    const rows = [...fig.closest('.test').querySelectorAll('tr[data-step]')];
    const speeds = [...fig.querySelectorAll('[data-speed]')];
    let at = -1, front = 0, timer = null, speed = 2;
    frames.forEach(frame => { if (frame.src) { const image = new Image(); image.src = frame.src; } });
    const stop = () => { clearTimeout(timer); timer = null; playButton.textContent = '▶'; playButton.setAttribute('aria-label', 'play'); };
    const place = frame => {
      if (!frame?.box || !frame.src) { mark.hidden = true; return; }
      const image = layers[front];
      if (!image.naturalWidth || !image.naturalHeight) { mark.hidden = true; return; }
      const scale = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight);
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      const left = (image.clientWidth - width) / 2, top = (image.clientHeight - height) / 2;
      mark.style.left = (left + frame.box.x * width) + 'px';
      mark.style.top = (top + frame.box.y * height) + 'px';
      mark.style.width = (frame.box.width * width) + 'px';
      mark.style.height = (frame.box.height * height) + 'px';
      mark.hidden = false;
    };
    const show = (index, animate = true) => {
      at = Math.max(0, Math.min(index, frames.length - 1));
      const frame = frames[at];
      const incoming = layers[1 - front];
      fig.style.setProperty('--fade', (reduced || !animate ? 0 : Math.min(620, 1100 / speed * .62)) + 'ms');
      incoming.src = frame.src || '';
      incoming.classList.toggle('on', !!frame.src);
      layers[front].classList.remove('on');
      front = 1 - front;
      if (frame.src) incoming.onload = () => place(frame);
      else mark.hidden = true;
      placeholder.hidden = !!frame.src;
      placeholder.textContent = frame.src ? '' : 'Frame ' + frame.status;
      label.textContent = frame.label + (frame.src ? '' : ' · frame ' + frame.status);
      counter.textContent = (at + 1) + ' / ' + frames.length;
      frameButtons.forEach((button, i) => {
        if (i === at) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
      rows.forEach(row => {
        if (Number(row.dataset.step) === frame.step && row.dataset.attempt === frame.attempt) row.setAttribute('aria-current', 'true');
        else row.removeAttribute('aria-current');
      });
    };
    const tick = () => { timer = setTimeout(() => { if (at >= frames.length - 1) { stop(); return; } show(at + 1); tick(); }, 1100 / speed); };
    fig.querySelector('[data-act="prev"]').addEventListener('click', () => { stop(); show(at - 1); });
    fig.querySelector('[data-act="next"]').addEventListener('click', () => { stop(); show(at + 1); });
    playButton.addEventListener('click', () => { if (timer) { stop(); return; } if (at >= frames.length - 1) show(0, false); playButton.textContent = 'Ⅱ'; playButton.setAttribute('aria-label', 'pause'); tick(); });
    fig.querySelector('[data-act="expand"]').addEventListener('click', event => {
      fig.classList.toggle('big');
      event.currentTarget.setAttribute('aria-pressed', String(fig.classList.contains('big')));
      event.currentTarget.textContent = fig.classList.contains('big') ? 'shrink' : 'expand';
      place(frames[at]);
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && fig.classList.contains('big')) { fig.classList.remove('big'); place(frames[at]); } });
    speeds.forEach(button => button.addEventListener('click', () => {
      speed = Number(button.dataset.speed);
      speeds.forEach(other => {
        if (other === button) other.setAttribute('aria-current', 'true');
        else other.removeAttribute('aria-current');
      });
      if (timer) { clearTimeout(timer); tick(); }
    }));
    frameButtons.forEach((button, index) => button.addEventListener('click', () => { stop(); show(index); }));
    rows.forEach(row => row.addEventListener('click', () => {
      const index = frames.findIndex(frame => frame.step === Number(row.dataset.step) && frame.attempt === row.dataset.attempt);
      if (index >= 0) { stop(); show(index); fig.scrollIntoView({block: 'nearest'}); }
    }));
    window.addEventListener('resize', () => place(frames[at]));
    show(Math.max(0, frames.findIndex(frame => frame.src)), false);
  });
})();`;
