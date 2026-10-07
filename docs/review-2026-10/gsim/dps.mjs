// Throwaway: re-implements Loadout's cooldown model (src/systems/Loadout.ts:60-111)
// and Combat's shared fireCooldown (Combat.ts:1849, 1937, 647-649) by hand.
const DT = 1/60, CARRY = DT, SWITCH = 0.25, EPS = 1e-9;
const W = {
  pistol:  { d: 9,  r: 3,   cd: {k:'none'} },
  magnum:  { d: 30, r: 1.6, cd: {k:'none'} },
  lastword:{ d: 14, r: 2.5, cd: {k:'none'} },
  kinetic: { d: 12, r: 3,   cd: {k:'none'} },
  laser:   { d: 18, r: 4,   cd: {k:'none'} },
  plasma:  { d: 28, r: 3,   cd: {k:'none'} },
  edge:    { d: 40, r: 2.5, cd: {k:'none'} },
  chain:   { d: 11, r: 10,  cd: {k:'heat', per: .035, cool: .2,  resume: .35} },
  rotary:  { d: 13, r: 12,  cd: {k:'heat', per: .035, cool: .22, resume: .35} },
  coil:    { d: 10, r: 9,   cd: {k:'heat', per: .035, cool: .24, resume: .35} },
  vent:    { d: 13, r: 11,  cd: {k:'heat', per: .04,  cool: .22, resume: .35} },
  rocket:  { d: 90, r: 1,   cd: {k:'chg', n: 1, re: 6, burst: 0} },
  grenade: { d: 60, r: 2.5, cd: {k:'chg', n: 3, re: 9, burst: .4} },
  seeker:  { d: 80, r: 1,   cd: {k:'chg', n: 1, re: 6, burst: 0} },
  seed:    { d: 45, r: 2.5, cd: {k:'chg', n: 3, re: 9, burst: .4} },
};
const cold = w => ({ heat: 0, locked: false, ch: w && w.cd.k==='chg' ? w.cd.n : 0, re: 0, next: -Infinity });
function tick(w, s, dt){ if(!w) return; if (w.cd.k==='heat'){ s.heat=Math.max(0,s.heat-w.cd.cool*dt); if(s.locked&&s.heat<=w.cd.resume) s.locked=false; } else if (w.cd.k==='chg' && s.re>0){ s.re-=dt; if(s.re<=0){s.re=0;s.ch=w.cd.n;} } }
function ready(w, s, t){ if(!w) return false; if(s.locked) return false; if(w.cd.k==='chg'&&s.ch<=0) return false; return t>=s.next; }
function spend(w, s, t){ if(w.cd.k==='heat'){ s.heat+=w.cd.per; if(s.heat>=1-1e-9){ s.heat=1; if(!s.locked){s.locked=true; return 'locked';} } } else if(w.cd.k==='chg'){ s.ch-=1; s.next=t+w.cd.burst; if(s.ch<=0){ s.re=w.cd.re; return 'emptied'; } } return null; }

// Simulates a held trigger for T seconds with: primary P, sidearm S, heavy H,
// autoSwap (locked primary falls to sidearm), heavyMode: 'none' | 'desktop' | 'touch'.
function run({P, S='pistol', H=null, autoSwap=false, heavyMode='none', T=300}){
  const p=W[P], s=W[S], h=H?W[H]:null;
  const st={primary:cold(p), sidearm:cold(s), heavy:cold(h)};
  let active='primary', prev='primary', switchUntil=-Infinity, fcd=0, dealt=0, dealtHeavy=0, t=0;
  const steps=Math.round(T/DT);
  for(let i=0;i<steps;i++){
    t=i*DT;
    tick(p,st.primary,DT); tick(s,st.sidearm,DT); tick(h,st.heavy,DT);
    fcd-=DT; if(fcd<-CARRY) fcd=-CARRY;
    // desktop rotation: when heavy is fully charged and we are on primary, select heavy
    if(heavyMode==='desktop' && h && active==='primary' && t>=switchUntil && st.heavy.ch===h.cd.n){ prev=active; active='heavy'; switchUntil=t+SWITCH; fcd=0; }
    if(heavyMode==='touch' && h && ready(h,st.heavy,t) && fcd<=0){
      // fireSlotOnce: fires heavy, sets fcd = 1/rate (no switch event)
      dealt+=h.d; dealtHeavy+=h.d; spend(h,st.heavy,t); fcd=1/h.r; continue;
    }
    // firingSlot
    let slot=null;
    const canFire = t>=switchUntil && ready(W[active==='primary'?P:active==='sidearm'?S:H], st[active], t);
    if(canFire) slot=active;
    else if(autoSwap && active==='primary' && st.primary.locked && ready(s,st.sidearm,t)) slot='sidearm';
    if(slot===null) continue;
    if(fcd>0) continue;
    const w = slot==='primary'?p:slot==='sidearm'?s:h;
    fcd=Math.max(fcd,-CARRY)+1/w.r;
    dealt+=w.d; if(slot==='heavy') dealtHeavy+=w.d;
    const tip=spend(w,st[slot],t);
    if(tip==='emptied' && slot==='heavy' && active==='heavy'){ active=prev; switchUntil=t+SWITCH; fcd=0; }
  }
  return { dps: dealt/T, heavyShare: dealtHeavy/T };
}
const f=x=>x.toFixed(1);
console.log('== Primary sustained DPS (held trigger, 300 s, multiplier 1) ==');
for(const P of ['kinetic','laser','plasma','edge','chain','rotary','coil','vent']){
  const noSwap=run({P}).dps, pist=run({P,autoSwap:true}).dps, mag=run({P,S:'magnum',autoSwap:true}).dps, lw=run({P,S:'lastword',autoSwap:true}).dps;
  console.log(`${P.padEnd(8)} firing ${f(W[P].d*W[P].r).padStart(6)}  desktop(no auto-swap) ${f(noSwap).padStart(6)}  +pistol ${f(pist).padStart(6)}  +magnum ${f(mag).padStart(6)}  +lastword ${f(lw).padStart(6)}`);
}
console.log('\n== Heavy slot: total single-target DPS with the heavy used on cooldown ==');
for(const P of ['kinetic','laser','plasma','edge','chain','rotary']){
  const base=run({P}).dps;
  const row=[];
  for(const H of ['rocket','grenade','seeker','seed']){
    const d=run({P,H,heavyMode:'desktop'}).dps, tch=run({P,H,heavyMode:'touch',autoSwap:true}).dps, tbase=run({P,autoSwap:true}).dps;
    row.push(`${H}: desk ${d-base>=0?'+':''}${f(d-base)} / touch ${tch-tbase>=0?'+':''}${f(tch-tbase)}`);
  }
  console.log(`${P.padEnd(8)} base ${f(base)} | `+row.join(' | '));
}
console.log('\n(seed drum linger 8 dps x 3 s per shell not included; blasts hit packs)');
