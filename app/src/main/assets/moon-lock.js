/* Moonlit Lock (file kept as moon-lock.js) for the reader's WebView: shows the
   real current moon phase, plus the date and tap state and a progress-driven,
   four-impact layered glass effect. */
(function () {
  'use strict';

  const UNLOCK_KEY = 'moon_lock_cheat_unlock_until';
  const UNLOCK_MS = 60 * 60 * 1000;
  // Days without the tap unlock (not a holiday/Sunday/odd Saturday) are opened with a
  // puzzle instead, for half an hour. The real timing is native (MoonUnlockStore).
  const PUZZLE_UNLOCK_MS = 30 * 60 * 1000;
  const TEST_TARGET = 20; // hidden settings test run: short, ignores the date, never saves an unlock
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
  const phaseEl = $('night-lock-phase');
  const stage = $('night-lock-stage');
  const flash = $('night-lock-flash');
  const glass = $('night-lock-glass');
  const canvases = ['draw-refract','draw-reflect','draw-fractures','draw-mainline','draw-noise'].map($);
  const contexts = canvases.map(canvas => canvas && canvas.getContext('2d'));
  const STAR_DIRECTIONS = Array.from({length:8},(_,i)=>[Math.cos(i*Math.PI/4),Math.sin(i*Math.PI/4)]);
  let state = null, tracker = null, seed = 0, system = null, unlockReady = false;
  let shown = 0, frame = 0, lastProgressAt = 0, finishTimer = 0;
  let lastDrawQ = -1;
  let memoryUnlockUntil = 0, drawWarningShown = false;
  let sgInst = null, shatterOn = false;
  // New faceted shattered-glass renderer (shatter-glass.js). Falls back to the layered
  // generateGlass/drawGlass renderer below if the module or a canvas context is unavailable.
  function shatterReady() {
    try {
      if (!glass || typeof window.ShatterGlass !== 'function') return null;
      if (!sgInst) sgInst = new window.ShatterGlass(glass, {progressMode:true, stagger:true, impacts:4, density:1, maxFacets:650, seed:1});
      return sgInst;
    } catch (error) { sgInst = null; return null; }
  }

  const pad = n => String(n).padStart(2, '0');
  function localKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isCheatDay(d) {
    return holidays.has(localKey(d)) || d.getDay() === 0 ||
      (d.getDay() === 6 && Math.ceil(d.getDate() / 7) % 2 === 1);
  }
  // Inside the Android app the unlock lives natively (MoonUnlockStore.kt): a
  // signed record in private storage, timed on the monotonic clock. The page
  // can only start it and ask whether it is still running. Outside the app
  // (a plain browser, the Node tests) it is held in memory only, never in
  // localStorage, so there is nothing to edit.
  function nativeBridge() {
    const b = window.AndroidBridge;
    return b && typeof b.moonUnlockRemainingMs === 'function' && typeof b.moonUnlockGrant === 'function' ? b : null;
  }
  function isUnlocked(now) {
    const b = nativeBridge();
    if (b) { try { return Number(b.moonUnlockRemainingMs()) > 0; } catch (_) { return false; } }
    return memoryUnlockUntil > (now === undefined ? Date.now() : now);
  }
  // grantUnlock() = the one-hour tap unlock; grantUnlock('puzzle') = the half-hour puzzle unlock.
  function grantUnlock(kind) {
    const puzzle = kind === 'puzzle', b = nativeBridge();
    if (b) {
      try {
        if (!puzzle) b.moonUnlockGrant();
        else if (typeof b.moonUnlockGrantPuzzle === 'function') b.moonUnlockGrantPuzzle();
      } catch (_) { /* not saved: the app stays locked */ }
      return;
    }
    memoryUnlockUntil=Date.now()+(puzzle ? PUZZLE_UNLOCK_MS : UNLOCK_MS);
  }
  // The old localStorage value is no longer read; remove any leftover copy.
  try { localStorage.removeItem(UNLOCK_KEY); } catch (_) { /* storage unavailable */ }
  function randomTarget() {
    const a = new Uint32Array(1);
    const crypt=window.crypto;
    if (crypt && crypt.getRandomValues) crypt.getRandomValues(a);
    else a[0] = Math.floor(Math.random() * 4294967296);
    return 50 + (a[0] % 51);
  }
  function advanceTap(progress) {
    if(progress.count<progress.target)progress.count++;
    const count=Math.min(progress.count,progress.target);
    return {count,target:progress.target,progress:Math.min(1,count/progress.target),phaseIndex:count%8,done:count>=progress.target};
  }
  function crackFraction(seg,p){const t=clamp((p-seg.start)/Math.max(1e-6,seg.end-seg.start));return 1-(1-t)*(1-t);}
  function fillOpacity(p){const t=clamp((p-.82)/.18);return t*t*(3-2*t);}
  function renderProgress(p){return p>=1?1:Math.floor(clamp(p)*40)/40;}
  function strokeScale(p){return 1+1.2*clamp(p);}
  function facetOpacity(facet,p,dark){const pop=clamp((p-facet.at)/.075);return (dark?[.09,.16,.23]:[.07,.13,.19])[facet.level]*(1-Math.pow(1-pop,3))*(1-fillOpacity(p));}
  function visibleSegmentCount(sys,p){return sys.segs.reduce((n,seg)=>n+(crackFraction(seg,p)>0?1:0),0);}
  function visibleFacetCount(sys,p){return sys.facets.reduce((n,facet)=>n+(p>facet.at?1:0),0);}
  function terminalPalette(dark){return dark?{fill:'#fff',crack:'#000'}:{fill:'#000',crack:'#fff'};}
  function shakeAmplitude(p){return 2+10*clamp(p);}
  function impactFlash(web,p){const g=clamp((p-web.delay)/(1-web.delay));return {progress:g,radius:5+19*g,opacity:.16+.74*(1-g)};}
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
  // ---- Real moon phase -------------------------------------------------
  // Low-precision sun/moon longitudes (Meeus-style, good to about a degree),
  // so the lock shows the phase you would see in the sky, not a tap counter.
  const PHASE_NAMES = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  function moonPhaseInfo(date) {
    const d = ((date ? date.getTime() : Date.now()) - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const rad = Math.PI / 180, wrap = x => ((x % 360) + 360) % 360;
    const moonLon = 218.316 + 13.176396 * d + 6.289 * Math.sin(rad * wrap(134.963 + 13.064993 * d));
    const g = rad * wrap(357.528 + 0.9856003 * d);
    const sunLon = 280.460 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    const elongation = wrap(moonLon - sunLon);       // 0 new, 90 first quarter, 180 full, 270 last quarter
    const fraction = elongation / 360;                // 0..1 through the cycle
    const illumination = (1 - Math.cos(rad * elongation)) / 2;
    const index = Math.floor(fraction * 8 + 0.5) % 8;
    return {fraction, illumination, index, name: PHASE_NAMES[index], waxing: fraction < .5};
  }
  // Lit part of the moon for any point in the cycle (not just the 8 steps).
  function moonPhasePath(fraction, cx, cy, r) {
    const theta = 2 * Math.PI * fraction, c = Math.cos(theta), illum = (1 - c) / 2;
    if (illum < .015) return '';
    if (illum > .985) return `M ${cx-r} ${cy} A ${r} ${r} 0 1 1 ${cx+r} ${cy} A ${r} ${r} 0 1 1 ${cx-r} ${cy} Z`;
    const waxing = fraction < .5, top = `${cx} ${cy-r}`, bottom = `${cx} ${cy+r}`;
    const limbSweep = waxing ? 1 : 0, rx = r * Math.abs(c);
    const termSweep = waxing ? (c > 0 ? 0 : 1) : (c > 0 ? 1 : 0);
    const term = rx < .5 ? `L ${top}` : `A ${rx} ${r} 0 0 ${termSweep} ${top}`;
    return `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} ${term} Z`;
  }
  function updateMoon(active) {
    const dark = isDarkTheme();
    const lit = dark ? '#f3efe0' : '#1c1c28', dim = dark ? '#2a2a36' : '#d9d6cc';
    moonDisc.setAttribute('fill', dim); moonDisc.setAttribute('stroke', lit);
    moonDisc.setAttribute('stroke-opacity', '.35'); moonDisc.setAttribute('stroke-width', '1.5');
    const phase = moonPhaseInfo(new Date());
    // Starts on tonight's real phase; every tap steps the moon on to the next phase.
    const taps = active && state ? state.count % 8 : 0;
    let name = phase.name;
    if (taps) {
      const idx = (phase.index + taps) % 8;
      moonLit.setAttribute('d', phasePath(idx, 60, 60, 50));
      name = PHASE_NAMES[idx];
    } else {
      moonLit.setAttribute('d', moonPhasePath(phase.fraction, 60, 60, 50));
    }
    moonLit.setAttribute('fill', lit);
    moonButton.classList.toggle('active', !!active); moonButton.disabled = !active;
    moonSvg.style.filter = dark ? 'drop-shadow(0 0 16px rgba(243,239,224,.35))' : 'none';
    moonSvg.setAttribute('aria-label', name);
    if (phaseEl) phaseEl.textContent = name;
  }

  function rngFor(s) {
    let a = s >>> 0;
    return function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const clamp = n => Math.max(0, Math.min(1, n));
  function isDarkTheme() {
    const root=getComputedStyle(document.documentElement), scheme=root.colorScheme;
    if(scheme==='light')return false;if(scheme==='dark')return true;
    const bg=root.getPropertyValue('--bg').trim()||'#0b0d12',n=parseInt(bg.replace('#',''),16);
    if(!Number.isFinite(n))return true;
    const channels=[(n>>16)&255,(n>>8)&255,n&255].map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);});
    return .2126*channels[0]+.7152*channels[1]+.0722*channels[2]<.45;
  }
  function generateGlass(w, h, s) {
    const rnd = rngFor(s), webs = [], segs = [], facets = [], rayCount = 26;
    const order = [0,1,2,3];
    for(let i=order.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
    const impacts = [
      {side:'top',cx:()=>w*(.3+rnd()*.4),cy:()=>3+rnd()*5,inward:90},
      {side:'right',cx:()=>w-3-rnd()*5,cy:()=>h*(.3+rnd()*.4),inward:180},
      {side:'bottom',cx:()=>w*(.3+rnd()*.4),cy:()=>h-3-rnd()*5,inward:270},
      {side:'left',cx:()=>3+rnd()*5,cy:()=>h*(.3+rnd()*.4),inward:0}
    ];
    for (let wi = 0; wi < impacts.length; wi++) {
      const impact=impacts[wi],cx=impact.cx(),cy=impact.cy(),inward=impact.inward;
      const rmax = Math.hypot(Math.max(cx,w-cx), Math.max(cy,h-cy)) * 1.14;
      const delay = order[wi] * .18; webs.push({cx,cy,rmax,delay,side:impact.side,stagger:order[wi]});
      // Keep the 26-ray silhouette, but use wider rings and fewer optional
      // links so total path count stays bounded on lower-end phones.
      const radii = []; for (let r = 12; r < rmax; r += r < 64 ? r * (.3 + rnd()*.2) : 56 + rnd()*24) radii.push(r); radii.push(rmax);
      const rings = [];
      for (let ri = 0; ri < radii.length; ri++) {
        const pts = [];
        for (let ray = 0; ray < rayCount; ray++) {
          const angle = inward - 100 + (200/(rayCount-1))*ray + (rnd()-.5)*4 + (ri ? (rnd()-.5)*12 : 0);
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
      const addFacet=(a,b,c)=>{
        if(!a||!b||!c)return;
        const reach=Math.max(...[a,b,c].map(p=>Math.hypot(p.x-cx,p.y-cy)));
        const span=(1-delay)*.94;
        const fx=(a.x+b.x+c.x)/3,fy=(a.y+b.y+c.y)/3,level=Math.floor(rnd()*3),seedValue=rnd(),roll=rnd(),spin=rnd()-.5,kick=.6+rnd()*1.4,tilted=roll<.18,away=Math.atan2(fy-cy,fx-cx);
        // About 1 in 5 shards is displaced: tilted up to ~8 degrees and nudged away from the impact.
        facets.push({points:new Float32Array([a.x,a.y,b.x,b.y,c.x,c.y]),cx:fx,cy:fy,at:Math.min(.98,delay+span*reach/rmax),level,seed:seedValue,tilt:tilted?spin*.28:0,pushX:tilted?Math.cos(away)*kick:0,pushY:tilted?Math.sin(away)*kick:0});
      };
      for (let ri=0; ri<rings.length; ri++) for (let ray=0; ray<rayCount; ray++) {
        if (ri) add(rings[ri-1][ray],rings[ri][ray]);
        if (ray && rnd()<.4) add(rings[ri][ray-1],rings[ri][ray]);
        if (ri && ray && rnd()<.14) add(rings[ri-1][ray-1],rings[ri][ray]);
        if(ri<rings.length-1&&ray<rayCount-1){
          const a=rings[ri][ray],b=rings[ri+1][ray],c=rings[ri+1][ray+1],d=rings[ri][ray+1];
          addFacet(a,b,c);addFacet(a,c,d);
        }
      }
    }
    return {
      w,h,webs,segs,facets,rayCount,
      visibleSegments:new Int32Array(segs.length),
      segmentProgress:new Float32Array(segs.length),
      visibleFacets:[new Uint32Array(facets.length),new Uint32Array(facets.length),new Uint32Array(facets.length)],
      visibleFacetCounts:new Uint32Array(3)
    };
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
  function appendPartial(ctx,seg,f){
    if(f<=0)return;
    const a=seg.a,b=seg.b,c=seg.cp,m=1-f;
    const cx=a.x+(c.x-a.x)*f,cy=a.y+(c.y-a.y)*f;
    const x=m*m*a.x+2*m*f*c.x+f*f*b.x,y=m*m*a.y+2*m*f*c.y+f*f*b.y;
    ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(cx,cy,x,y);
  }
  function drawGlass(progress) {
    if(!glass||(!system&&!shatterOn))return;
    progress=renderProgress(progress); // Limit full-canvas redraws to 40 visual steps.
    if(progress===lastDrawQ)return;lastDrawQ=progress;
    if(shatterOn&&sgInst){sgInst.setProgress(progress,isDarkTheme());return;}
    const dark=isDarkTheme(),terminal=progress>=1?terminalPalette(dark):null;
    const inverse=terminal?terminal.fill:(dark?'#fff':'#000'),base=terminal?terminal.crack:(dark?'#000':'#fff');
    const [refract,reflect,facets,mainline,noise]=contexts;
    refract.clearRect(0,0,system.w,system.h);reflect.clearRect(0,0,system.w,system.h);facets.clearRect(0,0,system.w,system.h);mainline.clearRect(0,0,system.w,system.h);noise.clearRect(0,0,system.w,system.h);

    const fill=fillOpacity(progress);
    if(fill){refract.globalAlpha=fill;refract.fillStyle=inverse;refract.fillRect(0,0,system.w,system.h);refract.globalAlpha=1;}
    // Four compact radial glows; no full-screen image copies or retained GPU surfaces.
    for(const web of system.webs){
      const g=clamp((progress-web.delay)/(1-web.delay));if(!g)continue;
      const radius=g*web.rmax*.5,gradient=refract.createRadialGradient(web.cx,web.cy,0,web.cx,web.cy,radius||1);
      gradient.addColorStop(0,dark?'rgba(255,255,255,.75)':'rgba(0,0,0,.75)');gradient.addColorStop(1,dark?'rgba(255,255,255,0)':'rgba(0,0,0,0)');
      refract.globalAlpha=.65*clamp((g-.05)/.8);refract.fillStyle=gradient;refract.beginPath();refract.arc(web.cx,web.cy,radius,0,Math.PI*2);refract.fill();refract.globalAlpha=1;
    }

    let segmentCount=0;
    for(let i=0;i<system.segs.length;i++){
      const f=crackFraction(system.segs[i],progress);if(f<=0)continue;
      system.visibleSegments[segmentCount]=i;system.segmentProgress[i]=f;segmentCount++;
    }
    system.visibleFacetCounts.fill(0);
    for(let i=0;i<system.facets.length;i++){
      const facet=system.facets[i];if(progress>facet.at){const group=system.visibleFacets[facet.level],count=system.visibleFacetCounts[facet.level]++;group[count]=i;}
    }

    // Three batched paths retain brightness tiers. Facets pop from 84% to full
    // scale as progress crosses their precomputed arrival window.
    const levelAlpha=dark?[.09,.16,.23]:[.07,.13,.19];
    for(let level=0;level<3;level++){
      const count=system.visibleFacetCounts[level];if(!count||fill>=1)continue;
      const ids=system.visibleFacets[level];facets.beginPath();
      for(let j=0;j<count;j++){
        const facet=system.facets[ids[j]],pop=clamp((progress-facet.at)/.075),scale=.84+.16*pop,p=facet.points;
        const cs=facet.tilt?Math.cos(facet.tilt):1,sn=facet.tilt?Math.sin(facet.tilt):0,ox=facet.cx+facet.pushX*pop,oy=facet.cy+facet.pushY*pop;
        for(let k=0;k<6;k+=2){
          const rx=(p[k]-facet.cx)*scale,ry=(p[k+1]-facet.cy)*scale,x=ox+rx*cs-ry*sn,y=oy+rx*sn+ry*cs;
          if(k)facets.lineTo(x,y);else facets.moveTo(x,y);
        }
        facets.closePath();
      }
      facets.globalAlpha=levelAlpha[level]*(1-fill);facets.fillStyle=inverse;facets.fill();facets.globalAlpha=1;
    }

    // Pre-sized typed arrays hold visible indices and eased growth fractions;
    // the same active set feeds all crack layers without allocating point lists.
    refract.beginPath();reflect.beginPath();mainline.beginPath();
    for(let j=0;j<segmentCount;j++){
      const index=system.visibleSegments[j],seg=system.segs[index],f=system.segmentProgress[index];
      appendPartial(refract,seg,f);appendPartial(reflect,seg,f);appendPartial(mainline,seg,f);
    }
    refract.lineCap='round';refract.strokeStyle=dark?'rgba(0,0,0,.22)':'rgba(255,255,255,.22)';refract.lineWidth=4;refract.stroke();
    reflect.lineCap='round';reflect.strokeStyle='rgba(255,255,255,.16)';reflect.lineWidth=9;reflect.stroke();
    reflect.strokeStyle='rgba(255,255,255,.55)';reflect.lineWidth=1.5;reflect.stroke();

    const thickness=strokeScale(progress);
    mainline.lineCap='round';mainline.lineJoin='round';mainline.strokeStyle=dark?'rgba(255,255,255,.16)':'rgba(0,0,0,.16)';mainline.lineWidth=5*thickness;mainline.stroke();
    mainline.strokeStyle=dark?'rgba(255,255,255,.94)':'rgba(0,0,0,.9)';mainline.lineWidth=1.1*thickness;mainline.stroke();
    mainline.strokeStyle=base;mainline.globalAlpha=.15+.85*clamp((progress-.3)/.6);mainline.lineWidth=progress>=1?1.7:.75;mainline.stroke();mainline.globalAlpha=1;

    // Sparse, deterministic branches and scratches reuse segment math. No per-frame
    // RNG, point arrays, or trigonometric lookup is needed for this texture pass.
    facets.beginPath();noise.beginPath();
    for(let j=0;j<segmentCount;j++){
      const index=system.visibleSegments[j],seg=system.segs[index],f=system.segmentProgress[index];if(f<.45||!(seg.seed>.9||seg.seed<.11))continue;
      const a=seg.a,b=seg.b,c=seg.cp,t=.5,m=.5,x=m*m*a.x+2*m*t*c.x+t*t*b.x,y=m*m*a.y+2*m*t*c.y+t*t*b.y;
      const dx=2*m*(c.x-a.x)+2*t*(b.x-c.x),dy=2*m*(c.y-a.y)+2*t*(b.y-c.y),d=Math.hypot(dx,dy)||1,nx=dy/d,ny=-dx/d;
      if(seg.seed>.9){const r=3+seg.seed*4;facets.moveTo(x-nx*r,y-ny*r);facets.lineTo(x+nx*r*2,y+ny*r*2);facets.lineTo(x+nx*r,y+ny*r);facets.lineTo(x-nx*r*2,y-ny*r*2);facets.closePath();}
      if(seg.seed<.11){const side=seg.seed<.055?-1:1,off=side*4,len=4+seg.seed*25;noise.moveTo(x+nx*off,y+ny*off);noise.lineTo(x+nx*off+dx/d*len,y+ny*off+dy/d*len);}
    }
    facets.globalAlpha=.38*(1-fill);facets.fillStyle=inverse;facets.fill();facets.globalAlpha=1;
    noise.strokeStyle=dark?'rgba(255,255,255,.3)':'rgba(0,0,0,.28)';noise.lineWidth=.65;noise.stroke();

    // Starbursts are only four small paths and follow their independently staggered web.
    for(const web of system.webs){
      const flashState=impactFlash(web,progress),g=flashState.progress;if(!g)continue;
      const radius=flashState.radius;reflect.save();reflect.globalAlpha=flashState.opacity;reflect.strokeStyle=inverse;reflect.lineWidth=1+g;reflect.beginPath();
      for(let ray=0;ray<8;ray++){const [dx,dy]=STAR_DIRECTIONS[ray],inner=radius*(ray%2?.16:.28),outer=radius*(ray%2?.72:1.2);reflect.moveTo(web.cx+dx*inner,web.cy+dy*inner);reflect.lineTo(web.cx+dx*outer,web.cy+dy*outer);}
      reflect.stroke();reflect.restore();
    }
  }

  function render() {
    if (!state) return;
    updateMoon(state.active && !state.done);
    if (state.active) {
      try { drawGlass(shown); }
      catch (error) {
        // A graphics API failure should never strand the user on the lock.
        if(!drawWarningShown){drawWarningShown=true;console.warn('Moon-lock canvas draw skipped:',error);}
      }
    }
  }
  function animate(now) {
    frame = 0;
    const duration = lastProgressMs || (state && state.done ? 900 : 350);
    const t = clamp((now-lastProgressAt)/duration), eased = t*t*(3-2*t);
    shown = lastProgressFrom + (lastProgressTo-lastProgressFrom)*eased;
    render();
    if (t < 1) frame = requestAnimationFrame(animate);
    else if (state && state.done) finishTimer = setTimeout(() => {
      if (state.test) { if (window.NovelMoonLock && window.NovelMoonLock.onTestFinished) window.NovelMoonLock.onTestFinished(); return; }
      if (isUnlocked()) {
        unlockReady = true;
        if (window.NovelMoonLock && window.NovelMoonLock.onUnlocked) window.NovelMoonLock.onUnlocked();
      }
    }, 250);
  }
  let lastProgressFrom=0, lastProgressTo=0, lastProgressMs=0;
  function setProgress(to, ms) {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(finishTimer); lastProgressMs=ms||0; lastProgressFrom=shown; lastProgressTo=to; lastProgressAt=performance.now();
    frame=requestAnimationFrame(animate);
  }

  // ---- Logic puzzles (non-holiday days) ---------------------------------
  // Six pure-logic puzzles live in moon-puzzles.js (window.MoonPuzzles): timing, grid match,
  // light routing, math & combinatorics, sequence programming and a Mastermind variant.
  // No trivia. A random type is shown each time; solving any one grants the unlock.
  const MP = window.MoonPuzzles || null;

  const puzzlePanel = $('night-lock-puzzle');
  const puzzleGrid = $('pz-grid');
  const puzzleMoves = $('pz-moves');
  const puzzleMsg = $('pz-msg');
  const puzzleTitle = $('pz-title');
  const lockBox = $('night-lock-box');
  let puzzleKind = null, puzzleState = null, puzzleDone = false, puzzleAvailable = false;

  // The puzzle has no button. It opens when you tap one particular star in the lock
  // screen's sky, chosen at random each time the lock appears. Nothing marks it: no
  // element, no highlight, no feedback for any other tap. These are the positions
  // (percent of the screen) of the stars drawn by the .sky CSS in index.html.
  const STAR_SPOTS = [[33.4,16.5],[9.8,53.4],[8.5,50.7],[43.8,8.7],[42.9,81.4],[24,62.2],[57.2,40.1],[7.4,84.4],[16.6,13.3],[79.7,19.3],[63.1,37.8],[8.9,7.7],[67,43],[58,45.5],[77.7,69.1],[57,52.4],[71.6,29.6],[14.1,42.1],[17.3,48.9],[65.8,75.4],[85.3,32.1],[58.9,57.7],[82,92.7],[65.4,7.8],[63.8,97.3],[29.8,39],[5.1,46.3],[14,7.7],[15.2,25.8],[84.9,9.7],[54.6,86.8],[84.2,28.7],[36.7,86.9],[17.2,18.9],[24.9,48.6],[27.7,2.4],[37.7,56.4]];
  const STAR_HIT = 26; // px: how close a tap has to be to the star
  let secretStar = null;
  function randomIndex(n) {
    const a = new Uint32Array(1), crypt = window.crypto;
    if (crypt && crypt.getRandomValues) crypt.getRandomValues(a); else a[0] = Math.floor(Math.random() * 4294967296);
    return a[0] % n;
  }
  // Is a tap at (x, y) on the star at `star` ([x%, y%]) in a screen of the given rect?
  function isStarHit(star, rect, x, y) {
    if (!star || !rect) return false;
    const dx = x - (rect.left + rect.width * star[0] / 100), dy = y - (rect.top + rect.height * star[1] / 100);
    return dx * dx + dy * dy <= STAR_HIT * STAR_HIT;
  }
  // Picks the secret star, leaving out stars sitting under a button (a tap there
  // would hit the button instead of the star).
  function pickSecretStar() {
    secretStar = null;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const avoid = [moonButton, $('night-lock-test-exit')].filter(Boolean)
      .map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    const free = STAR_SPOTS.filter(st => {
      const px = rect.left + rect.width * st[0] / 100, py = rect.top + rect.height * st[1] / 100;
      return avoid.every(r => px < r.left - STAR_HIT || px > r.right + STAR_HIT || py < r.top - STAR_HIT || py > r.bottom + STAR_HIT);
    });
    const pool = free.length ? free : STAR_SPOTS;
    secretStar = pool[randomIndex(pool.length)];
    updateStarMark();
  }
  // Hidden test run only (the moon in the Reading panel): a faint ring shows where the secret
  // star is, so the puzzles are easy to reach. The real lock never marks it.
  function updateStarMark() {
    if (!stage) return;
    let m = $('night-lock-star-mark');
    const show = state && state.test && puzzleAvailable && secretStar && !(lockBox && lockBox.classList.contains('puzzle-open'));
    if (!show) { if (m) m.remove(); return; }
    if (!m) {
      m = document.createElement('div'); m.id = 'night-lock-star-mark'; m.setAttribute('aria-hidden', 'true');
      m.style.cssText = 'position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:1px solid var(--text);opacity:.45;pointer-events:none;z-index:0';
      stage.appendChild(m);
    }
    m.style.left = secretStar[0] + '%'; m.style.top = secretStar[1] + '%';
  }

  function renderPuzzle() {
    const p = MP && MP.get(puzzleKind);
    if (!puzzleGrid || !p || !puzzleState) return;
    if (puzzleTitle) puzzleTitle.textContent = p.name;
    if (puzzleMoves) puzzleMoves.textContent = p.status(puzzleState);
    puzzleGrid.classList.toggle('pz-done', puzzleDone);
    p.render(puzzleGrid, puzzleState, onPuzzleChange, puzzleDone);
  }
  // Called by a puzzle after every tap: redraw, then see whether it is now solved.
  function onPuzzleChange() {
    if (puzzleDone || !puzzleState) return;
    renderPuzzle();
    const p = MP && MP.get(puzzleKind);
    if (p && p.solved(puzzleState)) onPuzzleSolved();
  }
  function newPuzzle() {
    if (!MP) return;
    puzzleKind = MP.pickType(null, puzzleKind);
    puzzleState = MP.make(puzzleKind); puzzleDone = false;
    if (puzzleMsg) puzzleMsg.textContent = MP.get(puzzleKind).rule;
    renderPuzzle();
  }
  function openPuzzle() {
    if (!puzzleAvailable || !puzzlePanel || !MP) return;
    puzzleKind = null; newPuzzle();
    puzzlePanel.classList.remove('hidden');
    if (lockBox) lockBox.classList.add('puzzle-open');
    updateStarMark();
  }
  function closePuzzle() {
    if (puzzlePanel) puzzlePanel.classList.add('hidden');
    if (lockBox) lockBox.classList.remove('puzzle-open');
    updateStarMark();
  }
  // Called by startSession: the secret star only exists on non-holiday days (or in the hidden test run).
  function resetPuzzle(available) {
    puzzleAvailable = available && !!MP; puzzleKind = null; puzzleState = null; puzzleDone = false;
    closePuzzle();
    if (puzzleAvailable) pickSecretStar(); else secretStar = null;
  }
  // Called when the app is reopened while still locked: a fresh random star, and any
  // half-played puzzle is put away. Does nothing once a puzzle has been solved.
  function resetStar() {
    if (!puzzleAvailable || puzzleDone) return;
    puzzleKind = null; puzzleState = null;
    closePuzzle();
    pickSecretStar();
  }
  function onPuzzleSolved() {
    puzzleDone = true; renderPuzzle();
    if (state && state.test) {                       // hidden test run: never saves an unlock
      if (puzzleMsg) puzzleMsg.textContent = 'Solved! (test: nothing saved)';
      finishTimer = setTimeout(() => { if (window.NovelMoonLock && window.NovelMoonLock.onTestFinished) window.NovelMoonLock.onTestFinished(); }, 1200);
      return;
    }
    grantUnlock('puzzle');
    if (!isUnlocked()) {                              // couldn't be saved: stay locked, let them retry
      puzzleDone = false;
      if (puzzleMsg) puzzleMsg.textContent = 'Solved, but the unlock could not be saved. Try a new puzzle.';
      renderPuzzle();
      return;
    }
    if (puzzleMsg) puzzleMsg.textContent = 'Unlocked for 30 minutes.';
    shatterAfterPuzzle();
  }
  // The screen cracks and shatters over the solved puzzle, then (same path as the moon taps)
  // animate() waits a moment and calls onUnlocked, which opens the reader.
  function shatterAfterPuzzle() {
    if (!state) return;
    if (!state.active) {                            // puzzle day: the glass was not started with the session
      try {
        clearCanvases(); lastDrawQ = -1; shown = 0; system = null; shatterOn = false;
        const sg = shatterReady();
        if (sg) { sg.begin(seed); shatterOn = true; }
        else { const size = prepareCanvases(); system = generateGlass(size.w, size.h, seed); }
      } catch (error) { system = null; shatterOn = false; }
      state.active = true;
    }
    state.done = true; state.progress = 1;
    shakeForProgress(1); finalFlash();
    setProgress(1, 1600);
  }
  if (stage) stage.addEventListener('click', function (e) {
    if (!puzzleAvailable || !secretStar || (lockBox && lockBox.classList.contains('puzzle-open'))) return;
    if (e.target.closest && e.target.closest('button, #night-lock-puzzle')) return;
    if (isStarHit(secretStar, stage.getBoundingClientRect(), e.clientX, e.clientY)) openPuzzle();
  });
  if ($('pz-back')) $('pz-back').addEventListener('click', closePuzzle);
  if ($('pz-new')) $('pz-new').addEventListener('click', () => { if (!puzzleDone) newPuzzle(); });

  function startSession(options) {
    const test=!!(options && options.test), active=test || isCheatDay(new Date());
    if (frame) { cancelAnimationFrame(frame); frame=0; }
    clearTimeout(finishTimer);
    tracker=active ? {target:test ? TEST_TARGET : randomTarget(),count:0} : null;
    state={active,count:active ? 0 : 4,done:false,test}; shown=0;
    unlockReady=false;
    resetPuzzle(test || !isCheatDay(new Date()));
    lastDrawQ=-1;
    seed=(Math.random()*0x7fffffff)|0; system=null; shatterOn=false;
    try {
      clearCanvases();
      if (active) { const sg=shatterReady(); if(sg){sg.begin(seed);shatterOn=true;} else {const size=prepareCanvases();system=generateGlass(size.w,size.h,seed);} }
    } catch (error) {
      // Keep the tap/unlock state machine usable if this device lacks a canvas context.
      system=null; shatterOn=false;
      if(!drawWarningShown){drawWarningShown=true;console.warn('Moon-lock canvas setup skipped:',error);}
    }
    render();
  }
  function shakeForProgress(progress){
    if(!stage||!stage.animate)return;
    try {
      if(stage.getAnimations)stage.getAnimations().forEach(animation=>animation.cancel());
      const amount=shakeAmplitude(progress);
      stage.animate([
        {transform:'translateX(0)'},{transform:`translateX(${-amount}px)`},{transform:`translateX(${amount}px)`},
        {transform:`translateX(${-amount*.65}px)`},{transform:`translateX(${amount*.35}px)`},{transform:'translateX(0)'}
      ],{duration:180+progress*100,easing:'ease-out'});
    } catch (_) { /* motion is decorative; keep the tap handler alive */ }
  }
  function finalFlash(){
    if(!flash||!flash.animate)return;
    try {
      if(flash.getAnimations)flash.getAnimations().forEach(animation=>animation.cancel());
      flash.animate([{opacity:0},{opacity:.92,offset:.18},{opacity:0}],{duration:260,easing:'ease-out'});
    } catch (_) { /* final flash is optional */ }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports={STAR_SPOTS,STAR_HIT,isStarHit,PUZZLE_UNLOCK_MS,isUnlocked,grantUnlock,TEST_TARGET,isCheatDay,localKey,phasePath,moonPhaseInfo,moonPhasePath,randomTarget,advanceTap,generateGlass,crackFraction,fillOpacity,renderProgress,strokeScale,facetOpacity,visibleSegmentCount,visibleFacetCount,terminalPalette,shakeAmplitude,impactFlash};
  if (moonButton) moonButton.addEventListener('click', function () {
    if (!tracker || !state || state.done) return;
    state=Object.assign(state,advanceTap(tracker));
    if (state.done && !state.test) grantUnlock();
    shakeForProgress(state.progress);
    if(state.done)finalFlash();
    setProgress(state.progress);
    try { if(moonSvg.animate)moonSvg.animate([{transform:'scale(.88)'},{transform:'scale(1)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'}); } catch (_) { /* phase and progress remain functional without WAAPI */ }
  });
  if(window.addEventListener)window.addEventListener('resize', function () { if(state && state.active && !shatterOn){ const size=prepareCanvases();system=generateGlass(size.w,size.h,seed);lastDrawQ=-1;drawGlass(shown); } });
  function stopSession() {
    if (frame) { cancelAnimationFrame(frame); frame=0; }
    clearTimeout(finishTimer);
    try { clearCanvases(); if(sgInst)sgInst.reset(); } catch (_) { /* nothing to clear */ }
    shatterOn=false;
    state=null; tracker=null; system=null; shown=0; lastDrawQ=-1;
    updateStarMark();
  }
  window.NovelMoonLock = { moonPhaseInfo, moonPhasePath, isUnlocked, canDismiss:() => unlockReady, startSession, stopSession, resetStar, onUnlocked:null, onTestFinished:null, isCheatDay, _secretStar:() => secretStar };
})();
