// Throwaway: per-chapter threat table for SPEC-041's reference kit
// (Marine 6/5/1/1 at the main-path levels 3/7/10/13/15/17, Rocket from ch2,
// drone L1 from ch4). Pure arithmetic over src/data numbers.
const L = {1:3,2:7,3:10,4:13,5:15,6:17};
const kit = {1:['Kinetic',36,0,0,0],2:['Laser',72,11.3,15,0],3:['Laser',72,11.3,15,0],4:['Laser',72,11.3,15,18],5:['Plasma',84,10.8,15,28],6:['Plasma',84,10.8,30,28]};
const trash = {1:[26,70,45, 4,9,7],2:[35,95,61, 5,12,9],3:[47,128,82, 7,15,12],4:[64,172,111, 9,20,15],5:[47,233,149, 7,26,20],6:[47,233,149, 7,26,20]};
const boss = {1:['Wurm',1800,18],2:['Matriarch',4600,23],3:['Broodlord',5200,30],4:['Titan',6800,40],5:['Queen',8400,51],6:['(eden_final)',0,0]};
// worst boss hit: max over moves of damageMult x phase mult
const worstMult = {1:1.5*1.2, 2:1.0, 3:1.2*1.2, 4:1.2*1.44, 5:1.2*1.2, 6:0};
console.log('ch | lvl | HP  | kit (armor) | DPS | swarm/rusher/ranged TTK s | rusher hit %HP | boss pure TTK | boss worst hit %HP');
for (let c=1;c<=6;c++){
  const lv=L[c]; const hp=120+40+4*(lv-1);
  const [w,base,rocket,armor,droneShot]=kit[c];
  const m=1.1*(1+0.04*6)*(1+0.02*(lv-1))*(1+0.07*0.5);
  const dps=(base+rocket)*m + droneShot*0.5*1.1*(m/1.035);
  const red=armor/(armor+100);
  const [sh,rh,ah,sd,rd,ad]=trash[c];
  const tt=[sh,rh,ah].map(h=>(h/(base*m)).toFixed(2)).join(' / ');
  const rhit=(rd*1.3*(1-red)/hp*100).toFixed(0); // rusher charge contact x1.3
  const [bn,bhp,bd]=boss[c];
  const bt=bhp? (bhp/dps).toFixed(0)+' s ('+bn+')':'-';
  const bw=bhp? (bd*worstMult[c]*(1-red)/hp*100).toFixed(0)+'%':'-';
  console.log(`${c}  | ${lv}  | ${hp} | ${w}${rocket?'+Rkt':''}${droneShot?'+Drn':''} (${armor}) | ${dps.toFixed(0)} | ${tt} | ${rhit}% | ${bt} | ${bw}`);
}
