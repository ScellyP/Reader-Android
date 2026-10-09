/* Moon-lock cheat for the reader's WebView: date and tap state plus a
   progress-driven, four-impact layered glass effect. */
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
  const stage = $('night-lock-stage');
  const flash = $('night-lock-flash');
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
  function isUnlocked(now) { return unlockUntil() > (now === undefined ? Date.now() : now); }
  function grantUnlock() {
    try { localStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_MS)); } catch (_) { /* storage may be disabled */ }
  }
  function randomTarget() {
    const a = new Uint32Array(1);
    const crypt=window.crypto;
    if (crypt && crypt.getRandomValues) crypt.getRandomValues(a);
    else a[0] = Math.floor(Math.random() * 4294967296);
    return 1 + (a[0] % 100);
  }
  function advanceTap(progress) {
    if(progress.count<progress.target)progress.count++;
    const count=Math.min(progress.count,progress.target);
    return {count,target:progress.target,progress:Math.min(1,count/progress.target),phaseIndex:count%8,done:count>=progress.target};
  }
  function crackFraction(seg,p){const t=clamp((p-seg.start)/Math.max(1e-6,seg.end-seg.start));return 1-(1-t)*(1-t);}
  function fillOpacity(p){const t=clamp((p-.82)/.18);return t*t*(3-2*t);}
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
  function updateMoon(index, active) {
    const dark = isDarkTheme();
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
      const radii = []; for (let r = 12; r < rmax; r += r < 64 ? r * (.3 + rnd()*.2) : 32 + rnd()*18) radii.push(r); radii.push(rmax);
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
        facets.push({points:[a,b,c],at:Math.min(.98,delay+span*reach/rmax),level:Math.floor(rnd()*3),seed:rnd()});
      };
      for (let ri=0; ri<rings.length; ri++) for (let ray=0; ray<rayCount; ray++) {
        if (ri) add(rings[ri-1][ray],rings[ri][ray]);
        if (ray && rnd()<.58) add(rings[ri][ray-1],rings[ri][ray]);
        if (ri && ray && rnd()<.22) add(rings[ri-1][ray-1],rings[ri][ray]);
        if(ri<rings.length-1&&ray<rayCount-1){
          const a=rings[ri][ray],b=rings[ri+1][ray],c=rings[ri+1][ray+1],d=rings[ri][ray+1];
          addFacet(a,b,c);addFacet(a,c,d);
        }
      }
    }
    return {w,h,webs,segs,facets,rayCount};
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
  function appendCurve(ctx,pts,offset){
    if(pts.length<2)return;
    pts.forEach((p,i)=>{const x=p.x+p.nx*offset,y=p.y+p.ny*offset;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  }
  function drawGlass(progress) {
    if (!glass || !system) return;
    progress = Math.round(progress * 120) / 120;
    if (progress === lastDrawQ) return;
    lastDrawQ = progress;
    const dark = isDarkTheme(), terminal=progress>=1?terminalPalette(dark):null;
    const inverse = terminal ? terminal.fill : (dark ? '#fff' : '#000');
    const base = terminal ? terminal.crack : (dark ? '#000' : '#fff');
    const [refract,reflect,fractures,mainline,noise]=canvases.map(c=>c.getContext('2d'));
    for(const ctx of [refract,reflect,fractures,mainline,noise])ctx.clearRect(0,0,system.w,system.h);

    // Refraction layer: soft impact pools and the inverse-colour glass wash.
    refract.fillStyle=inverse;
    const terminalFill=fillOpacity(progress);
    if(terminalFill){refract.globalAlpha=terminalFill;refract.fillRect(0,0,system.w,system.h);refract.globalAlpha=1;}
    for(const web of system.webs){
      const g=clamp((progress-web.delay)/(1-web.delay));if(!g)continue;
      const radius=g*web.rmax*.62, gradient=refract.createRadialGradient(web.cx,web.cy,0,web.cx,web.cy,radius||1);
      gradient.addColorStop(0,dark?'rgba(255,255,255,.9)':'rgba(0,0,0,.9)');
      gradient.addColorStop(.55,dark?'rgba(255,255,255,.55)':'rgba(0,0,0,.55)');
      gradient.addColorStop(1,dark?'rgba(255,255,255,0)':'rgba(0,0,0,0)');
      refract.globalAlpha=.9*clamp((g-.05)/.8);refract.fillStyle=gradient;refract.beginPath();refract.arc(web.cx,web.cy,radius,0,Math.PI*2);refract.fill();refract.globalAlpha=1;
    }

    // Batch facets into brightness buckets to keep dense webs inexpensive to draw.
    const facetGroups=Array.from({length:3},()=>Array.from({length:8},()=>[]));
    for(const facet of system.facets){
      const raw=clamp((progress-facet.at)/.075);if(!raw)continue;
      const pop=1-Math.pow(1-raw,3),cx=(facet.points[0].x+facet.points[1].x+facet.points[2].x)/3,cy=(facet.points[0].y+facet.points[1].y+facet.points[2].y)/3;
      const scale=.84+.16*pop,alpha=facetOpacity(facet,progress,dark);
      if(alpha<=.002)continue;
      const bucket=Math.min(7,Math.floor(alpha/.23*8));
      facetGroups[facet.level][bucket].push(facet.points.map(p=>({x:cx+(p.x-cx)*scale,y:cy+(p.y-cy)*scale})));
    }
    for(let level=0;level<3;level++)for(let bucket=0;bucket<8;bucket++){
      const triangles=facetGroups[level][bucket];if(!triangles.length)continue;
      fractures.beginPath();for(const tri of triangles){fractures.moveTo(tri[0].x,tri[0].y);fractures.lineTo(tri[1].x,tri[1].y);fractures.lineTo(tri[2].x,tri[2].y);fractures.closePath();}
      fractures.globalAlpha=Math.min(.23,(bucket+.5)*.23/8);fractures.fillStyle=inverse;fractures.fill();fractures.globalAlpha=1;
    }

    const active=[],shardPaths=[];
    for(const seg of system.segs){
      const f=clamp((progress-seg.start)/Math.max(.000001,seg.end-seg.start));if(!f)continue;
      const pts=curvePoints(seg,f,12);active.push({seg,f,pts});
      // Fracture shards along longer segments, appearing as their point is reached.
      if(f>.65&&seg.seed>.83){
        const p=pts[Math.floor(pts.length/2)], z=2+seg.seed*5;
        shardPaths.push([{x:p.x-p.tx*z,y:p.y-p.ty*z},{x:p.x+p.nx*z*2,y:p.y+p.ny*z*2},{x:p.x+p.tx*z,y:p.y+p.ty*z},{x:p.x-p.nx*z*2,y:p.y-p.ny*z*2}]);
      }
    }
    // Draw the supplied pen's refraction/reflection layers in batched paths.
    refract.save();refract.shadowColor=inverse;refract.shadowBlur=4;refract.beginPath();
    for(const item of active)appendRibbon(refract,item.pts,4);
    refract.fillStyle=dark?'rgba(0,0,0,.14)':'rgba(255,255,255,.15)';refract.fill();refract.restore();
    reflect.beginPath();for(const item of active)appendRibbon(reflect,item.pts,14);
    reflect.globalAlpha=.2;reflect.fillStyle='rgba(255,255,255,.38)';reflect.fill();reflect.globalAlpha=1;
    reflect.beginPath();for(const item of active)appendRibbon(reflect,item.pts,2.5);
    reflect.globalAlpha=.35;reflect.fillStyle='rgba(255,255,255,.65)';reflect.fill();reflect.globalAlpha=1;
    if(shardPaths.length){fractures.beginPath();for(const poly of shardPaths){poly.forEach((p,i)=>i?fractures.lineTo(p.x,p.y):fractures.moveTo(p.x,p.y));fractures.closePath();}fractures.globalAlpha=.45;fractures.fillStyle=inverse;fractures.fill();fractures.globalAlpha=1;}

    // Side-specific starbursts scale with each impact's own staggered reach.
    for(const web of system.webs){
      const flashState=impactFlash(web,progress),g=flashState.progress;if(g<=0)continue;
      const radius=flashState.radius,alpha=flashState.opacity,turn=(web.stagger* Math.PI/4);
      reflect.save();reflect.globalAlpha=alpha;reflect.strokeStyle=inverse;reflect.lineWidth=1.1+1.1*g;
      const halo=reflect.createRadialGradient(web.cx,web.cy,0,web.cx,web.cy,radius*1.7);
      halo.addColorStop(0,dark?'rgba(255,255,255,.95)':'rgba(0,0,0,.8)');halo.addColorStop(1,dark?'rgba(255,255,255,0)':'rgba(0,0,0,0)');
      reflect.fillStyle=halo;reflect.beginPath();reflect.arc(web.cx,web.cy,radius*1.7,0,Math.PI*2);reflect.fill();
      reflect.beginPath();
      for(let ray=0;ray<8;ray++){const a=turn+ray*Math.PI/4,inner=radius*(ray%2?.16:.28),outer=radius*(ray%2?.72:1.2);reflect.moveTo(web.cx+Math.cos(a)*inner,web.cy+Math.sin(a)*inner);reflect.lineTo(web.cx+Math.cos(a)*outer,web.cy+Math.sin(a)*outer);}
      reflect.stroke();reflect.restore();
    }

    // Main line: broad glow, bright reflected edge, then a fine base-colour core.
    mainline.lineCap='round';mainline.lineJoin='round';
    const thickness=strokeScale(progress);
    mainline.beginPath();for(const item of active)appendCurve(mainline,item.pts,0);
    mainline.strokeStyle=dark?'rgba(255,255,255,.12)':'rgba(0,0,0,.12)';mainline.lineWidth=7*thickness;mainline.stroke();
    mainline.strokeStyle=dark?'rgba(255,255,255,.52)':'rgba(0,0,0,.48)';mainline.lineWidth=2.5*thickness;mainline.stroke();
    mainline.strokeStyle=dark?'rgba(255,255,255,.98)':'rgba(0,0,0,.94)';mainline.lineWidth=1.15*thickness;mainline.stroke();
    mainline.strokeStyle=base;mainline.globalAlpha=.15+.85*clamp((progress-.3)/.6);mainline.lineWidth=progress>=1?1.5:.8;mainline.stroke();mainline.globalAlpha=1;

    // Deterministic fine noise and hairline scratches beside the main fractures.
    noise.beginPath();
    for(const item of active){const {seg,pts}=item,rand=rngFor((seed^Math.floor(seg.seed*0xffffffff))>>>0),total=Math.min(5,Math.max(1,Math.floor(pts.length/5)));
      for(let i=0;i<total;i++){const p=pts[Math.floor(rand()*pts.length)],side=rand()<.5?-1:1,off=(2+rand()*7)*side,len=3+rand()*8,skew=(rand()-.5)*1.1;
        noise.moveTo(p.x+p.nx*off,p.y+p.ny*off);noise.lineTo(p.x+p.nx*(off+skew)+p.tx*len,p.y+p.ny*(off+skew)+p.ty*len);
      }
    }
    noise.lineWidth=.65;noise.strokeStyle=dark?'rgba(255,255,255,.34)':'rgba(0,0,0,.3)';noise.stroke();
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
  function shakeForProgress(progress){
    if(!stage||!stage.animate)return;
    stage.getAnimations().forEach(animation=>animation.cancel());
    const amount=shakeAmplitude(progress);
    stage.animate([
      {transform:'translateX(0)'},{transform:`translateX(${-amount}px)`},{transform:`translateX(${amount}px)`},
      {transform:`translateX(${-amount*.65}px)`},{transform:`translateX(${amount*.35}px)`},{transform:'translateX(0)'}
    ],{duration:180+progress*100,easing:'ease-out'});
  }
  function finalFlash(){
    if(!flash||!flash.animate)return;
    flash.getAnimations().forEach(animation=>animation.cancel());
    flash.animate([{opacity:0},{opacity:.92,offset:.18},{opacity:0}],{duration:260,easing:'ease-out'});
  }
  if (typeof module !== 'undefined' && module.exports) module.exports={isCheatDay,localKey,phasePath,randomTarget,advanceTap,generateGlass,crackFraction,fillOpacity,strokeScale,facetOpacity,visibleSegmentCount,visibleFacetCount,terminalPalette,shakeAmplitude,impactFlash};
  if (moonButton) moonButton.addEventListener('click', function () {
    if (!tracker || !state || state.done) return;
    state=Object.assign(state,advanceTap(tracker));
    if (state.done) grantUnlock();
    shakeForProgress(state.progress);
    if(state.done)finalFlash();
    setProgress(state.progress);
    moonSvg.animate([{transform:'scale(.88)'},{transform:'scale(1)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
  });
  if(window.addEventListener)window.addEventListener('resize', function () { if(state && state.active){ const size=prepareCanvases();system=generateGlass(size.w,size.h,seed);lastDrawQ=-1;drawGlass(shown); } });
  window.NovelMoonLock = { isUnlocked, canDismiss:() => unlockReady, startSession, onUnlocked:null, isCheatDay };
})();
