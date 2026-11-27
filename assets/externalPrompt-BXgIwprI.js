import{bW as l}from"./NodeVisual-CKvI339s.js";import{signatureOf as r,blurbOf as c}from"./catalogue-Ep52dpHS.js";import"./vendor-xyflow-CIfuUpQH.js";import"./vendor-react-CVkjjuGB.js";import"./tokens-_mHm_Vz2.js";import"./preload-DiXeQ6_L.js";import"./vendor-dagre-CdVMPvTX.js";const m="Write a shader for FastShaders, a node editor for three.js TSL (Three Shading Language). FastShaders turns your code into a node graph, so keep to these rules. Reply with ONE ```js code block shaped like the example.",u=["RULES","1. Use only the inputs and functions listed below, as free functions: mul(a, b), mix(a, b, t). No methods (a.mul(b)), no operators (+ - * /), no if, loops or helper functions.","2. One call per line: const name = fn(args); An argument is a number, an earlier const, an input, or ONE component of a const (name.x, name.y, name.z), never .xy or .rgb.","3. A value the user may tune is a uniform on its own line: const speed = uniform(1.5); or const tint = uniform(color(0xff8800));","4. Return one const (the colour), or an object of the channels below. A fixed value in it is float(0.5) or color(0xRRGGBB), never a bare number."].join(`
`),h=[[["color","emissive"],"vec3"],[["roughness","metalness"],"0 to 1"],[["opacity"],"0 to 1; it shows once Transparent is ticked in the Output node's menu, so say so"],[["discard"],"not 0 removes the surface; feed it greaterThan or lessThan"],[["normal"],"the result of heightToNormal"],[["position"],"a float: how far the surface moves along its normal"]],f=()=>["CHANNELS",...h.map(([e,n])=>`${e.join(", ")}: ${n}`)].join(`
`),d=(e,n)=>n?`${e} (-1 to 1)`:e;function p(e){const n=[],a=[],t=[],s=[];for(const o of e.entries)o.kind==="global"||o.kind==="uv"?n.push(r(o)):o.kind==="noise"?t.push(d(o.name,o.signed)):l.has(o.name)?a.push(r(o)):s.push(`- ${r(o)}: ${c(o.def)}`);return[`INPUTS (bare, no parentheses, except uv()): ${n.join(", ")}`,"",`FUNCTIONS: ${a.join(", ")}`,...t.length>0?["",`NOISE (one argument, the position): ${t.join(", ")}`]:[],...s.length>0?["","FASTSHADERS' OWN FUNCTIONS (three.js does not have them):",...s]:[]].join(`
`)}const i={request:"Blue and orange patches that drift slowly, on a slightly shiny surface.",code:`import { add, color, float, Fn, mix, mul, mx_noise_float, positionGeometry, smoothstep, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const patchScale = uniform(3);
  const driftSpeed = uniform(0.2);
  const coolColor = uniform(color(0x1e5aa8));
  const warmColor = uniform(color(0xf28c28));
  const drift = mul(time, driftSpeed);
  const scaled = mul(positionGeometry, patchScale);
  const moved = add(scaled, drift);
  const n = mx_noise_float(moved);
  const blend = smoothstep(-0.3, 0.3, n);
  const base = mix(coolColor, warmColor, blend);
  return { color: base, roughness: float(0.3) };
});
export default shader;`};function A(e){return[m,"",u,"",f(),"",p(e),"",`EXAMPLE: ${i.request}`,"```js",i.code,"```","","Now write the shader I describe next."].join(`
`)}export{h as EXTERNAL_CHANNELS,i as EXTERNAL_EXAMPLE,m as EXTERNAL_HEAD,u as EXTERNAL_RULES,p as externalListText,A as externalPrompt};
