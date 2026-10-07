// Throwaway: boss "pure DPS" fight lengths (100 % uptime, no misses), to compare
// the reference kit of SPEC-041 §4.3 against a player who follows the station's
// Refit line one chapter early. Numbers from src/data and Combat.ts formulas.
const bosses = [ ['Dune Wurm',1800,1,0.4], ['Frost Matriarch',4600,2,0.5], ['Hive Broodlord',5200,3,0.5], ['Ash Titan',6800,4,0.3], ['Hive Queen',8400,5,0.5] ];
const dmgMult = (might, L, marine=true) => (marine?1.1:1)*(1+0.04*might)*(1+0.02*(L-1));
const crit = ag => 1 + (0.05+0.02*ag)*0.5;
// sustained single-target DPS (from dps.mjs, desktop): rifle values; rocket rotation adds ~+10-13
const kit = {
  ref: {1:['kinetic',36,0,0],2:['laser',72,11.3,0],3:['laser',72,11.3,0],4:['laser',72,11.3,18],5:['plasma',84,10.8,28],6:['plasma',84,10.8,28]},
  // Refit followed a chapter early: Laser before the Wurm, Plasma before Thessaly/Ferrum
  early: {1:['laser',72,0,0],2:['laser',72,11.3,0],3:['plasma',84,10.8,0],4:['plasma',84,10.8,28],5:['edge',100,10.1,40],6:['edge',100,10.1,40]},
};
const level = {1:3,2:7,3:10,4:13,5:15,6:17};
for (const [name,hp,ch,ph2] of bosses){
  const out=[];
  for (const k of ['ref','early']){
    const [w,base,rocket,dronePerShot] = kit[k][ch];
    const m = dmgMult(6, level[ch]) * crit(1);
    const drone = dronePerShot ? dronePerShot*0.5*1*1.1 : 0; // drone L1: 0.5 x per-shot x 1/s x companionMult(tech1)=1.1
    const dps = (base + rocket)*m + drone*dmgMult(6, level[ch]);
    const t = hp/dps;
    out.push(`${k}: ${w}${rocket?'+rocket':''}${drone?'+drone':''} ${dps.toFixed(0)} dps -> ${t.toFixed(0)} s (phase-2 part ${(t*ph2).toFixed(0)} s)`);
  }
  console.log(`${name.padEnd(16)} ${hp}  | ${out.join(' | ')}`);
}
