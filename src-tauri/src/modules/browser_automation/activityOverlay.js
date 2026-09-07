(() => {
  const key = '__anboAutomationVisualV1';
  if (window[key]) return;
  let host, root, cursor, ring, target, badge, label, tool, detail, logo;
  let control, idle = false;
  let iconBrand, iconAsset;
  let badgePoint, badgeActor, badgeWidth = 0, badgeHeight = 0, viewportWidth = 0, viewportHeight = 0;
  let resizeObserver, motionQuery, motionChanged;
  let animations = [];
  let latest = 0;
  let request;
  let scheduled = 0, pending;
  const resetPointer = () => {
    badgePoint = null;
    if (cursor) { cursor.style.display = 'none'; cursor.style.opacity = '0'; }
    if (ring) ring.style.display = 'none';
    if (target) target.style.display = 'none';
  };
  const hide = () => {
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    pending = null;
    resizeObserver?.disconnect();
    if (motionQuery && motionChanged) motionQuery.removeEventListener('change', motionChanged);
    for (const animation of animations) animation.cancel();
    animations = [];
    host?.remove();
    host = root = cursor = ring = target = badge = label = tool = detail = logo = null;
    badgePoint = badgeActor = control = null;
    badgeWidth = badgeHeight = viewportWidth = viewportHeight = 0;
  };
  const positionBadge = (smooth = false) => {
    if (!badge || !badgeWidth || !badgeHeight || !viewportWidth || !viewportHeight) return;
    let x = 10, y = viewportHeight - badgeHeight - 10;
    if (badgePoint) {
      x = badgePoint.x + 12;
      y = badgePoint.y + 20;
      if (x + badgeWidth > viewportWidth - 10) x = badgePoint.x - badgeWidth - 12;
      if (y + badgeHeight > viewportHeight - 10) y = badgePoint.y - badgeHeight - 10;
    }
    x = Math.max(10, Math.min(x, viewportWidth - badgeWidth - 10));
    y = Math.max(10, Math.min(y, viewportHeight - badgeHeight - 10));
    badge.dataset.placement = badgePoint ? 'pointer' : 'docked';
    badge.style.transition = smooth && badge.style.visibility === 'visible' ? '' : 'none';
    badge.style.transform = `translate(${x}px,${y}px)`;
    badge.style.visibility = 'visible';
  };
  const create = () => {
    if (host?.isConnected) return;
    hide();
    host = document.createElement('anbo-automation-visual');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-anbo-visual', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;contain:strict!important;display:block!important;';
    root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host{--a:#8b80ff;--b:#54d5e8;--c:#f391ca;color-scheme:dark;pointer-events:none}
      *{box-sizing:border-box;pointer-events:none!important}
      .edge{position:absolute;inset:0;border:2px solid transparent;border-image:linear-gradient(135deg,var(--a),var(--b),var(--c),var(--a)) 1;opacity:.7}
      .track{position:absolute;inset:0;overflow:hidden}
      :host([data-idle]) .track{visibility:hidden}
      :host([data-idle]) .edge{opacity:.3}
      .orb{position:absolute;width:72px;height:4px;border-radius:50%;background:linear-gradient(90deg,transparent,var(--b),#fff,var(--c),transparent);opacity:.9;will-change:transform}
      .badge{position:absolute;left:0;top:0;width:max-content;max-width:min(340px,calc(100% - 20px));visibility:hidden;display:flex;align-items:center;gap:8px;padding:7px 10px 7px 8px;border:1px solid #79cad42e;border-radius:6px;background:#0d202bf5;color:#e4f2f5;font:500 10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:0 6px 18px #00000024,0 1px 3px #00000024;transition:transform var(--travel,220ms) cubic-bezier(.22,.61,.36,1)}
      .logo{position:relative;display:grid;place-items:center;flex:none;width:24px;height:24px;border:1px solid #8ce0e51a;border-radius:50%;background:#6ed0dc12;color:#aad7df;font:650 11px system-ui,sans-serif}
      .logo img{position:absolute;width:16px;height:16px;object-fit:contain;opacity:0}.logo[data-loaded] img{opacity:1}.logo[data-loaded] .monogram{visibility:hidden}.logo img.inverted{filter:invert(1)}
      .copy{min-width:0;display:flex;flex-direction:column;gap:1px}.heading{display:flex;align-items:baseline;gap:5px;min-width:0;white-space:nowrap}
      .name{min-width:0;max-width:110px;flex:0 1 auto;font-weight:700;color:#e4f2f5;overflow:hidden;text-overflow:ellipsis}.separator{color:#58737f}.tool{min-width:0;flex:1;color:#a9c0cc;overflow:hidden;text-overflow:ellipsis}
      .detail{color:#91aab6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge[data-state=error] .detail{color:#ffb7a9}
      .cursor{position:absolute;left:0;top:0;width:14px;height:18px;display:none;opacity:0;transition:transform var(--travel,220ms) cubic-bezier(.22,.61,.36,1),opacity 180ms ease-out;filter:drop-shadow(0 1px 1px #0006);will-change:transform}.cursor svg{display:block;width:100%;height:100%}
      .ring{position:absolute;left:-15px;top:-15px;width:30px;height:30px;display:none}
      .target{position:absolute;left:0;top:0;display:none;border:1px solid #61c6d18c;border-radius:4px;background:#61c6d10b}
      .ring::after{content:'';position:absolute;inset:0;border:2px solid var(--b);border-radius:50%;animation:ripple 450ms ease-out both}
      @keyframes ripple{from{transform:scale(.35);opacity:1}to{transform:scale(1.5);opacity:0}}
      @media(prefers-reduced-motion:reduce){.orb{animation:none;display:none}.cursor,.badge{transition:none}.ring::after{animation:none;opacity:.7}}
      @media(max-width:420px){.badge{padding:6px 8px;gap:6px;font-size:9px}.logo{width:22px;height:22px}.name{max-width:85px}}
    `);
    root.adoptedStyleSheets = [sheet];
    const add = (className, parent = root) => {
      const node = document.createElement('div');
      node.className = className;
      parent.append(node);
      return node;
    };
    add('edge');
    const track = add('track');
    add('orb', track); add('orb second', track);
    badge = add('badge');
    logo = add('logo', badge);
    const copy = add('copy', badge), heading = add('heading', copy);
    label = add('name', heading);
    add('separator', heading).textContent = '\u00b7';
    tool = add('tool', heading);
    detail = add('detail', copy);
    target = add('target'); cursor = add('cursor'); ring = add('ring', cursor);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 16 20');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1 1V15L5 11.5L8 18L10 17L7 10.5H13Z');
    path.setAttribute('fill', '#10171d');
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('stroke-linejoin', 'round');
    arrow.append(path); cursor.append(arrow);
    (document.fullscreenElement || document.documentElement).append(host);
    motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    let previousSize = '';
    const animate = (force = false) => {
      if (!host?.isConnected) return;
      const { width: w, height: h } = host.getBoundingClientRect();
      const size = w + ',' + h;
      if (!force && previousSize === size) return;
      previousSize = size;
      const time = animations[0]?.currentTime || 0;
      for (const animation of animations) animation.cancel();
      animations = [];
      if (motionQuery.matches) return;
      const steps = [[0,-72,0,0],[.24,w-72,0,0],[.25,w-38,34,90],[.49,w-38,h-38,90],[.5,w-72,h-4,180],[.74,0,h-4,180],[.75,-34,h-38,270],[.99,-34,34,270],[1,-72,0,360]];
      const frames = steps.map(([offset,x,y,angle]) => ({offset,transform:`translate(${x}px,${y}px) rotate(${angle}deg)`}));
      root.querySelectorAll('.orb').forEach((orb,index) => {
        const animation = orb.animate(frames, {duration:9000,iterations:Infinity,easing:'linear',delay:index ? -4500 : 0});
        animation.currentTime = time;
        if (idle) animation.pause();
        animations.push(animation);
      });
    };
    resizeObserver = new ResizeObserver(entries => {
      let viewportChanged = false;
      for (const entry of entries) {
        if (entry.target === host) {
          viewportWidth = entry.contentRect.width;
          viewportHeight = entry.contentRect.height;
          viewportChanged = true;
        } else if (entry.target === badge) {
          badgeWidth = entry.borderBoxSize?.[0]?.inlineSize ?? badge.offsetWidth;
          badgeHeight = entry.borderBoxSize?.[0]?.blockSize ?? badge.offsetHeight;
        }
      }
      positionBadge(Boolean(badgePoint));
      if (viewportChanged) animate();
    });
    resizeObserver.observe(host);
    resizeObserver.observe(badge);
    motionChanged = () => animate(true);
    motionQuery.addEventListener('change', motionChanged);
  };
  const verbs = {click:'Clicking',double_click:'Double-clicking',type:'Typing',press:'Pressing a key',key:'Pressing a key',hover:'Hovering',drag:'Dragging',scroll:'Scrolling',scroll_to:'Scrolling',navigate:'Navigating',reload:'Reloading',back:'Going back',forward:'Going forward',find:'Finding a target',snapshot:'Reading the page',get_text:'Reading the page',wait:'Waiting for the page',screenshot:'Capturing',check:'Changing selection',select_option:'Selecting',focus:'Focusing',upload:'Attaching files',download:'Downloading',get_url:'Reading the address',page_info:'Reading page details',console_logs:'Reading console logs',download_status:'Checking download',download_wait:'Waiting for download',emulate:'Adjusting the viewport',stop:'Stopping navigation',dialog:'Handling a dialog',open:'Opening a tab',close:'Closing a tab',tabs:'Reading tabs'};
  const aliases = {type_text:'type',press_key:'press',upload_files:'upload',scroll_to_element:'scroll_to',scroll_into_view:'scroll_to',get_page_info:'page_info',list_tabs:'tabs'};
  const paintIcon = name => {
    logo.replaceChildren();
    delete logo.dataset.loaded;
    const monogram = document.createElement('span');
    monogram.className = 'monogram';
    monogram.textContent = name.charAt(0);
    logo.append(monogram);
    if (!iconAsset || iconBrand !== badgeActor) return;
    const container = logo, image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.className = iconAsset.invert ? 'inverted' : '';
    image.onload = () => { if (image.parentNode === container) container.dataset.loaded = ''; };
    image.onerror = () => { image.remove(); };
    image.src = iconAsset.source;
    container.append(image);
  };
  const draw = data => {
    if (document.hidden || !document.documentElement) return;
    create();
    if (request !== data.requestId) {
      ring.style.display = target.style.display = 'none';
      request = data.requestId;
    }
    const actorChanged = badgeActor !== data.actor?.brand || control !== data.controlId;
    if (actorChanged) resetPointer();
    badgeActor = data.actor?.brand;
    control = data.controlId;
    idle = data.phase === 'done' || data.phase === 'error';
    host.toggleAttribute('data-idle', idle);
    for (const animation of animations) { if (idle) animation.pause(); else animation.play(); }
    const name = String(data.actor?.label || 'Remote agent').slice(0,32);
    if (actorChanged || !logo.childNodes.length) paintIcon(name);
    const canonicalMethod = Object.hasOwn(aliases, data.method) ? aliases[data.method] : data.method;
    const knownMethod = Object.hasOwn(verbs, canonicalMethod);
    const method = knownMethod ? 'browser_' + (canonicalMethod === 'scroll_to' ? 'scroll_to_element' : canonicalMethod) : 'browser_action';
    const action = data.phase === 'error' ? 'Action stopped' : data.phase === 'done' ? 'Action complete' : data.phase === 'frame' ? 'Interacting in a frame' : (knownMethod ? verbs[canonicalMethod] : 'Working');
    if (label.textContent !== name) label.textContent = name;
    if (tool.textContent !== method) tool.textContent = method;
    badge.dataset.state = data.phase === 'error' ? 'error' : data.phase === 'done' ? 'done' : 'working';
    const point = data.point;
    const smoothPoint = Boolean(badgePoint);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      if (point.x >= 0 && point.y >= 0 && point.x <= innerWidth && point.y <= innerHeight) {
        if (badgePoint && (point.x !== badgePoint.x || point.y !== badgePoint.y)) {
          const distance = Math.hypot(point.x - badgePoint.x, point.y - badgePoint.y);
          host.style.setProperty('--travel', Math.round(Math.min(420, 90 + distance * .35)) + 'ms');
        }
        cursor.style.transition = badgePoint ? '' : 'none';
        badgePoint = { x: point.x, y: point.y };
        cursor.style.display = 'block';
        cursor.style.opacity = '1';
        cursor.style.transform = 'translate(' + point.x + 'px,' + point.y + 'px)';
        if (Number.isFinite(point.width) && Number.isFinite(point.height) && point.width > 0 && point.height > 0 && point.width <= innerWidth && point.height <= innerHeight) {
          target.style.display = 'block';
          target.style.width = point.width + 'px'; target.style.height = point.height + 'px';
          target.style.transform = 'translate(' + (point.x - point.width / 2) + 'px,' + (point.y - point.height / 2) + 'px)';
        }
        if (data.phase === 'click' || data.clicked) {
          const next = ring.cloneNode(false);
          ring.replaceWith(next); ring = next;
          ring.style.display = 'block';
        }
      } else resetPointer();
    }
    if (data.phase === 'frame') resetPointer();
    if (idle) ring.style.display = target.style.display = 'none';
    const description = action + (badgePoint ? ` \u00b7 x ${Math.round(badgePoint.x)} \u00b7 y ${Math.round(badgePoint.y)}` : '');
    if (detail.textContent !== description) detail.textContent = description;
    positionBadge(smoothPoint);
  };
  window.addEventListener('anbo-automation-visual', event => {
    const data = event.detail;
    if (!data || !Number.isSafeInteger(data.sequence) || data.sequence < latest) return;
    latest = data.sequence;
    if (data.phase === 'ended') { hide(); return; }
    if (iconBrand !== data.actor?.brand) { iconBrand = data.actor?.brand; iconAsset = null; }
    if (data.icon && typeof data.icon.source === 'string' && data.icon.source.length < 100000 && /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(data.icon.source)) {
      iconAsset = {source:data.icon.source,invert:data.icon.invert === true};
    }
    if (data.method === 'screenshot' && data.phase !== 'done' && data.phase !== 'error') { hide(); return; }
    if (document.hidden) return;
    const sameRequest = pending?.requestId === data.requestId;
    pending = {...data, point:data.phase === 'frame' ? null : data.point || (sameRequest ? pending?.point : null), clicked:data.phase === 'click' || (sameRequest && pending?.clicked)};
    if (!scheduled) scheduled = requestAnimationFrame(() => {
      const next = pending;
      scheduled = 0; pending = null;
      if (next) draw(next);
    });
  });
  window.addEventListener('anbo-automation-visual-hide', hide);
  document.addEventListener('visibilitychange', () => { if(document.hidden) hide(); });
  document.addEventListener('fullscreenchange', hide);
  window.addEventListener('pagehide', hide);
  window[key] = true;
})();
