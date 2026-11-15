// Figma Scripter 등에서 실행: 포스터를 순백 톤으로 바꾸면서 뉴모피즘 입체감을 유지한다.
// 바탕/카드/칩 = #FFFFFF, 안쪽 패널 = #F5F7FA, 좌상단 하이라이트는 옅은 회색 그림자로 대체.
function hex(h){const n=parseInt(h.slice(1),16);return {r:((n>>16)&255)/255,g:((n>>8)&255)/255,b:(n&255)/255};}
const OLD=hex('#E7EBF0'), WHITE={r:1,g:1,b:1}, WELL=hex('#F5F7FA'), DARK=hex('#AEBBCD'), LIGHTSH=hex('#D8E0EA'), BEV2=hex('#C6D0DD');
const same=(a,b)=>Math.abs(a.r-b.r)<0.003&&Math.abs(a.g-b.g)<0.003&&Math.abs(a.b-b.b)<0.003;
const poster = await figma.getNodeByIdAsync('1:2');   // 'HASH(Rocksdb) 포스터 90x140cm' 프레임
poster.fills=[{type:'SOLID',color:WHITE}];
for (const n of poster.findAll(()=>true)) {
  const hasInner = Array.isArray(n.effects) && n.effects.some(e=>e.type==='INNER_SHADOW');
  if ('fills' in n && Array.isArray(n.fills) && n.fills.length===1 && n.fills[0].type==='SOLID' && same(n.fills[0].color,OLD))
    n.fills=[{type:'SOLID',color: hasInner?WELL:WHITE}];
  if (Array.isArray(n.effects) && n.effects.length) {
    if (hasInner) n.effects = n.effects.map(e => e.color.r>0.99 ? {...e,color:{...WHITE,a:1}} : {...e,color:{...DARK,a:0.45}});
    else if (n.effects.some(e=>e.type==='DROP_SHADOW')) n.effects = n.effects.map(e => e.offset.x<0
      ? {...e,color:{...LIGHTSH,a:0.55},offset:{x:e.offset.x*0.4,y:e.offset.y*0.4},radius:e.radius*0.8}
      : {...e,color:{...DARK,a:0.42},radius:e.radius*1.15});
  }
  if ('strokes' in n && Array.isArray(n.strokes) && n.strokes.length===1 && n.strokes[0].type==='GRADIENT_LINEAR') {
    const g=n.strokes[0]; n.strokes=[{...g, gradientStops:[{position:0,color:{r:0.93,g:0.95,b:0.97,a:1}},{position:1,color:{...BEV2,a:1}}]}]; }
}
