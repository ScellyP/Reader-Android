/* Moon-lock cheat, adapted from the supplied moon-lock-cheat project for the
   reader's WebView. The lock remains governed by reader.js; this file owns
   only the optional moon interaction, date rules, unlock window and glass art. */
(function () {
  'use strict';

  const UNLOCK_KEY = 'moon_lock_cheat_unlock_until';
  const UNLOCK_MS = 60 * 60 * 1000;
  const holidays = new Set([
    '2026-08-26', '2026-08-29', '2026-09-05', '2026-09-14', '2026-09-19',
    '2026-09-26', '2026-10-02', '2026-10-03', '2026-10-10', '2026-10-17',
    '2026-10-20', '2026-10-21', '2026-10-31', '2026-11-01', '2026-11-07',
    '2026-11-10', '2026-11-21', '2026-11-27', '2026-12-05', '2026-12-19',
    '2026-12-25', '2027-01-26'
  ]);
  const $ = id => document.getElementById(id);
  const moonButton = $('night-lock-icon');
  const moonSvg = $('night-lock-moon');
  const moonDisc = $('night-lock-moon-disc');
  const moonLit = $('night-lock-moon-lit');
  const glass = $('night-lock-glass');
  const canvases = ['draw-refract','draw-reflect','draw-fractures','draw-mainline','draw-noise'].map($);
  let state = null, tracker = null, seed = 0, system = null, unlockReady = false;
  let shown = 0, frame = 0, lastProgressAt = 0, finishTimer = 0;
  let lastDrawQ = -1;

  const pad = n => String(n).padStart(2, '0');
  function localKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isCheatDay(d) {
    return holidays.has(localKey(d)) || d.getDay() === 0 ||
      (d.getDay() === 6 && Math.ceil(d.getDate() / 7) % 2 === 1);
  }
  function unlockUntil() {
    try { return Number(localStorage.getItem(UNLOCK_KEY) || 0) || 0; } catch (_) { return 0; }
  }
  function isUnlocked(now) { return unlockUntil() > (now || Date.now()); }
  function grantUnlock() {
    try { localStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_MS)); } catch (_) { /* storage may be disabled */ }
  }
  function randomTarget() {
    const a = new Uint32Array(1);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else a[0] = Math.floor(Math.random() * 4294967296);
    return 1 + (a[0] % 100);
  }
  function phasePath(index, cx, cy, r) {
    const k = ((index % 8) + 8) % 8;
    if (k === 0) return '';
    if (k === 4) return `M ${cx-r} ${cy} A ${r} ${r} 0 1 1 ${cx+r} ${cy} A ${r} ${r} 0 1 1 ${cx-r} ${cy} Z`;
    const waxing = k < 4, top = `${cx} ${cy-r}`, bottom = `${cx} ${cy+r}`;
    const limbSweep = waxing ? 1 : 0;
    const rx = r * Math.abs(Math.cos(k * Math.PI / 4));
    const quarter = k === 2 || k === 6;
    const termSweep = (k === 3 || k === 7) ? 1 : 0;
    const term = quarter ? `L ${top}` : `A ${rx} ${r} 0 0 ${termSweep} ${top}`;
    return `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} ${term} Z`;
  }
  function updateMoon(index, active) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0d12';
    const n = parseInt(bg.replace('#', ''), 16);
    const dark = Number.isFinite(n) && (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.45;
    const lit = dark ? '#f3efe0' : '#1c1c28', dim = dark ? '#2a2a36' : '#d9d6cc';
    moonDisc.setAttribute('fill', dim); moonDisc.setAttribute('stroke', lit);
    moonDisc.setAttribute('stroke-opacity', '.35'); moonDisc.setAttribute('stroke-width', '1.5');
    moonLit.setAttribute('d', phasePath(index, 60, 60, 50)); moonLit.setAttribute('fill', lit);
    moonButton.classList.toggle('active', !!active); moonButton.disabled = !active;
    moonSvg.setAttribute('aria-label', ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'][index % 8]);
  }

  function rngFor(s) {
    let a = s >>> 0;
    return function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const clamp = n => Math.max(0, Math.min(1, n));
  function generateGlass(w, h, s) {
    const rnd = rngFor(s), perimeter = 2 * (w + h), webs = [], segs = [];
    const order = [0,1,2,3,4,5,6].sort(() => rnd() - .5);
    for (let wi = 0; wi < 7; wi++) {
      const d = ((wi + .15 + rnd() * .7) / 7) * perimeter, inset = 3 + rnd() * 5;
      let cx, cy, inward;
      if (d < w) { cx = d; cy = inset; inward = 90; }
      else if (d < w + h) { cx = w - inset; cy = d - w; inward = 180; }
      else if (d < 2*w + h) { cx = w - (d-w-h); cy = h-inset; inward = 270; }
      else { cx = inset; cy = h - (d-2*w-h); inward = 0; }
      const rmax = Math.hypot(Math.max(cx,w-cx), Math.max(cy,h-cy)) * 1.05;
      const delay = order[wi] * .06; webs.push({cx,cy,rmax,delay});
      const radii = []; for (let r = 14; r < rmax; r += r < 60 ? r * (.4 + rnd()*.3) : 38 + rnd()*30) radii.push(r); radii.push(rmax);
      const rings = [];
      for (let ri = 0; ri < radii.length; ri++) {
        const pts = [];
        for (let ray = 0; ray < 15; ray++) {
          const angle = inward - 100 + (200/14)*ray + (rnd()-.5)*4 + (ri ? (rnd()-.5)*12 : 0);
          const rad = radii[ri] * (.88 + rnd()*.24);
          const x = cx + rad*Math.cos(angle*Math.PI/180), y = cy + rad*Math.sin(angle*Math.PI/180);
          pts.push(x < 0 || x > w || y < 0 || y > h ? null : {x,y});
        }
        rings.push(pts);
      }
      const add = (a,b) => {
        if (!a || !b) return;
        const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy); if (len < 3) return;
        const bend=(rnd()-.5)*Math.min(16,len*.22), cp={x:(a.x+b.x)/2-dy/len*bend,y:(a.y+b.y)/2+dx/len*bend};
        const ra=Math.hypot(a.x-cx,a.y-cy), rb=Math.hypot(b.x-cx,b.y-cy), rIn=Math.min(ra,rb), rOut=Math.max(ra,rb);
        const span=(1-delay)*.94, start=Math.min(.97,delay+span*rIn/rmax), end=Math.min(1,Math.max(start+.01,start+span*Math.max(rOut-rIn,.05*rmax)/rmax));
        segs.push({a,b,cp,start,end,seed:rnd()});
      };
      for (let ri=0; ri<rings.length; ri++) for (let ray=0; ray<15; ray++) {
        if (ri) add(rings[ri-1][ray],rings[ri][ray]);
        if (ray && rnd()<.58) add(rings[ri][ray-1],rings[ri][ray]);
        if (ri && ray && rnd()<.22) add(rings[ri-1][ray-1],rings[ri][ray]);
      }
    }
    return {w,h,webs,segs};
  }
  function prepareCanvases() {
    const rect=glass.getBoundingClientRect(), dpr=Math.min(window.devicePixelRatio||1,2);
    for(const canvas of canvases){
      canvas.width=Math.max(1,Math.round(rect.width*dpr));
      canvas.height=Math.max(1,Math.round(rect.height*dpr));
      const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
    }
    return {w:Math.max(1,rect.width),h:Math.max(1,rect.height)};
  }
  function clearCanvases(){ for(const canvas of canvases){ const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); } }
  function curvePoints(seg,f,spacing){
    const length=Math.hypot(seg.b.x-seg.a.x,seg.b.y-seg.a.y), count=Math.max(2,Math.ceil(length*f/spacing)), pts=[];
    for(let i=0;i<=count;i++){
      const t=f*i/count, m=1-t;
      const x=m*m*seg.a.x+2*m*t*seg.cp.x+t*t*seg.b.x, y=m*m*seg.a.y+2*m*t*seg.cp.y+t*t*seg.b.y;
      const dx=2*m*(seg.cp.x-seg.a.x)+2*t*(seg.b.x-seg.cp.x), dy=2*m*(seg.cp.y-seg.a.y)+2*t*(seg.b.y-seg.cp.y), d=Math.hypot(dx,dy)||1;
      pts.push({x,y,nx:dy/d,ny:-dx/d,tx:dx/d,ty:dy/d});
    }
    return pts;
  }
  function ribbon(ctx,pts,width,fill){
    if(pts.length<2)return;
    ctx.beginPath();
    pts.forEach((p,i)=>{const x=p.x+p.nx*width/2,y=p.y+p.ny*width/2;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
    for(let i=pts.length-1;i>=0;i--){const p=pts[i];ctx.lineTo(p.x-p.nx*width/2,p.y-p.ny*width/2);}
    ctx.closePath();ctx.fillStyle=fill;ctx.fill();
  }
  function drawCurve(ctx,pts,offset){
    if(pts.length<2)return;
    ctx.beginPath();pts.forEach((p,i)=>{const x=p.x+p.nx*offset,y=p.y+p.ny*offset;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
  }
  function drawGlass(progress) {
    if (!glass || !system) return;
    progress = Math.round(progress * 120) / 120;
    if (progress === lastDrawQ) return;
    lastDrawQ = progress;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0d12';
    const n = parseInt(bg.replace('#',''),16), dark = Number.isFinite(n) && (((n>>16)&255)+((n>>8)&255)+(n&255))/3 < 125;
    const inverse = dark ? '#fff' : '#000', base = dark ? '#000' : '#fff';
    const [refract,reflect,fractures,mainline,noise]=canvases.map(c=>c.getContext('2d'));
    for(const ctx of [refract,reflect,fractures,mainline,noise])ctx.clearRect(0,0,system.w,system.h);

    // Refraction layer: soft impact pools and the inverse-colour glass wash.
    refract.fillStyle=inverse;
    const fill=clamp((progress-.82)/.18), fillOpacity=fill*fill*(3-2*fill);
    if(fillOpacity){refract.globalAlpha=fillOpacity;refract.fillRect(0,0,system.w,system.h);refract.globalAlpha=1;}
    for(const web of system.webs){
      const g=clamp((progress-web.delay)/(1-web.delay));if(!g)continue;
      const radius=g*web.rmax*.62, gradient=refract.createRadialGradient(web.cx,web.cy,0,web.cx,web.cy,radius||1);
      gradient.addColorStop(0,dark?'rgba(255,255,255,.9)':'rgba(0,0,0,.9)');
      gradient.addColorStop(.55,dark?'rgba(255,255,255,.55)':'rgba(0,0,0,.55)');
      gradient.addColorStop(1,dark?'rgba(255,255,255,0)':'rgba(0,0,0,0)');
      refract.globalAlpha=.9*clamp((g-.05)/.8);refract.fillStyle=gradient;refract.beginPath();refract.arc(web.cx,web.cy,radius,0,Math.PI*2);refract.fill();refract.globalAlpha=1;
    }

    const active=[];
    for(const seg of system.segs){
      const f=clamp((progress-seg.start)/Math.max(.000001,seg.end-seg.start));if(!f)continue;
      const pts=curvePoints(seg,f,12);active.push({seg,f,pts});
      // Refracted edge tint, clipped into a narrow curved glass ribbon.
      refract.save();refract.shadowColor=inverse;refract.shadowBlur=4;
      ribbon(refract,pts,4,dark?'rgba(0,0,0,.14)':'rgba(255,255,255,.15)');refract.restore();

      // The source effect's transverse reflection: a fading ribbon crossing each crack.
      const mid=pts[Math.floor(pts.length/2)], grad=reflect.createLinearGradient(mid.x+mid.nx*7,mid.y+mid.ny*7,mid.x-mid.nx*7,mid.y-mid.ny*7);
      grad.addColorStop(0,'rgba(255,255,255,0)');grad.addColorStop(.5,'rgba(255,255,255,.52)');grad.addColorStop(1,'rgba(255,255,255,0)');
      reflect.globalAlpha=.3;ribbon(reflect,pts,14,grad);reflect.globalAlpha=1;

      // Fracture shards along longer segments, appearing as their point is reached.
      if(f>.65&&seg.seed>.83){
        const p=pts[Math.floor(pts.length/2)], z=2+seg.seed*5;
        fractures.fillStyle=dark?'rgba(255,255,255,.44)':'rgba(0,0,0,.4)';fractures.beginPath();
        fractures.moveTo(p.x-p.tx*z,p.y-p.ty*z);fractures.lineTo(p.x+p.nx*z*2,p.y+p.ny*z*2);
        fractures.lineTo(p.x+p.tx*z,p.y+p.ty*z);fractures.lineTo(p.x-p.nx*z*2,p.y-p.ny*z*2);fractures.closePath();fractures.fill();
      }
    }

    // Main line: broad glow, bright reflected edge, then a fine base-colour core.
    for(const item of active){const {pts}=item;
      mainline.lineCap='round';mainline.lineJoin='round';
      mainline.strokeStyle=dark?'rgba(255,255,255,.12)':'rgba(0,0,0,.12)';mainline.lineWidth=7;drawCurve(mainline,pts,0);
      mainline.strokeStyle=dark?'rgba(255,255,255,.52)':'rgba(0,0,0,.48)';mainline.lineWidth=2.5;drawCurve(mainline,pts,0);
      mainline.strokeStyle=dark?'rgba(255,255,255,.98)':'rgba(0,0,0,.94)';mainline.lineWidth=1.15;drawCurve(mainline,pts,0);
      mainline.strokeStyle=base;mainline.globalAlpha=.15+.85*clamp((progress-.3)/.6);mainline.lineWidth=.8;drawCurve(mainline,pts,0);mainline.globalAlpha=1;
    }

    // Deterministic fine noise and hairline scratches beside the main fractures.
    for(const item of active){const {seg,pts}=item,rand=rngFor((seed^Math.floor(seg.seed*0xffffffff))>>>0),total=Math.min(5,Math.max(1,Math.floor(pts.length/5)));
      noise.lineWidth=.65;noise.strokeStyle=dark?'rgba(255,255,255,.34)':'rgba(0,0,0,.3)';
      for(let i=0;i<total;i++){const p=pts[Math.floor(rand()*pts.length)],side=rand()<.5?-1:1,off=(2+rand()*7)*side,len=3+rand()*8,skew=(rand()-.5)*1.1;
        noise.beginPath();noise.moveTo(p.x+p.nx*off,p.y+p.ny*off);noise.lineTo(p.x+p.nx*(off+skew)+p.tx*len,p.y+p.ny*(off+skew)+p.ty*len);noise.stroke();
      }
    }
  }

  function render() {
    if (!state) return;
    updateMoon(state.count % 8, state.active && !state.done);
    if (state.active) drawGlass(shown);
  }
  function animate(now) {
    frame = 0;
    const duration = state && state.done ? 900 : 350;
    const t = clamp((now-lastProgressAt)/duration), eased = t*t*(3-2*t);
    shown = lastProgressFrom + (lastProgressTo-lastProgressFrom)*eased;
    render();
    if (t < 1) frame = requestAnimationFrame(animate);
    else if (state && state.done) finishTimer = setTimeout(() => {
      if (isUnlocked()) {
        unlockReady = true;
        if (window.NovelMoonLock && window.NovelMoonLock.onUnlocked) window.NovelMoonLock.onUnlocked();
      }
    }, 250);
  }
  let lastProgressFrom=0, lastProgressTo=0;
  function setProgress(to) {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(finishTimer); lastProgressFrom=shown; lastProgressTo=to; lastProgressAt=performance.now();
    frame=requestAnimationFrame(animate);
  }
  function startSession() {
    const active=isCheatDay(new Date());
    tracker=active ? {target:randomTarget(),count:0} : null;
    state={active,count:active ? 0 : 4,done:false}; shown=0;
    unlockReady=false;
    lastDrawQ=-1;
    seed=(Math.random()*0x7fffffff)|0; system=null;
    clearCanvases();
    if (active) {
      const size=prepareCanvases();system=generateGlass(size.w,size.h,seed);
    }
    render();
  }
  moonButton.addEventListener('click', function () {
    if (!tracker || !state || state.done) return;
    tracker.count++;
    state.count=tracker.count; state.done=tracker.count>=tracker.target;
    if (state.done) grantUnlock();
    setProgress(Math.min(1,tracker.count/tracker.target));
    moonSvg.animate([{transform:'scale(.88)'},{transform:'scale(1)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
  });
  window.addEventListener('resize', function () { if(state && state.active){ const size=prepareCanvases();system=generateGlass(size.w,size.h,seed);lastDrawQ=-1;drawGlass(shown); } });
  window.NovelMoonLock = { isUnlocked, canDismiss:() => unlockReady, startSession, onUnlocked:null, isCheatDay };
})();
