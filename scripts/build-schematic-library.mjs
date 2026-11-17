import fs from 'node:fs/promises';
// Original schematic geometry in metres, Y up. No external model credits needed.
const vertices = [-.5,-.5,-.5,.5,-.5,-.5,.5,.5,-.5,-.5,.5,-.5,-.5,-.5,.5,.5,-.5,.5,.5,.5,.5,-.5,.5,.5];
const indices = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,1,2,6,1,6,5,0,4,7,0,7,3];
const bin = Buffer.concat([Buffer.from(new Float32Array(vertices).buffer),Buffer.from(new Uint16Array(indices).buffer)]);
const box=(x,y,z,w,h,d,color=0)=>({translation:[x,y,z],scale:[w,h,d],mesh:color});
const wheel=(x,z)=>box(x,.29,z,.25,.58,.58,1);
const specs=[
 {id:'car',name:'Small car',height:1.5,nodes:[box(0,.55,0,1.7,.65,3.8),box(0,1.13,-.15,1.45,.74,1.9,2),...[-.82,.82].flatMap(x=>[-1.1,1.1].map(z=>wheel(x,z)))]},
 {id:'motorcycle',name:'Motorcycle',height:1.2,nodes:[box(0,.63,0,.4,.35,1.3),box(0,.9,-.1,.55,.12,.7,1),box(0,.3,-.75,.24,.6,.6,1),box(0,.3,.75,.24,.6,.6,1),box(0,1.1,.57,.8,.2,.12,2)]},
 {id:'doorway',name:'Doorway',height:2.1,nodes:[box(-.5,1.05,0,.12,2.1,.18),box(.5,1.05,0,.12,2.1,.18),box(0,2.04,0,1,.12,.18),box(0,1,0,.86,2,.05,2)]},
 {id:'adult-marker',name:'Adult height marker',height:1.75,nodes:[box(0,1.6,0,.3,.3,.3),box(0,1.1,0,.42,.7,.22),box(-.13,.4,0,.17,.8,.19),box(.13,.4,0,.17,.8,.19),box(-.33,1.08,0,.15,.65,.18),box(.33,1.08,0,.15,.65,.18)]}
];
let library=JSON.parse(await fs.readFile('public/models/library.json','utf8')).filter(e=>e.source!=='schematic');
for(const spec of specs){
 const colors=[[.95,.6,.14,1],[.06,.08,.1,1],[.25,.6,.75,1]];
 const gltf={asset:{version:'2.0',generator:'Waterline schematic library'},scene:0,scenes:[{nodes:spec.nodes.map((_,i)=>i)}],nodes:spec.nodes,meshes:colors.map((_,i)=>({primitives:[{attributes:{POSITION:0},indices:1,material:i}]})),materials:colors.map(c=>({pbrMetallicRoughness:{baseColorFactor:c,metallicFactor:0,roughnessFactor:.8},doubleSided:true})),buffers:[{byteLength:bin.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:96,target:34962},{buffer:0,byteOffset:96,byteLength:72,target:34963}],accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-.5,-.5,-.5],max:[.5,.5,.5]},{bufferView:1,componentType:5123,count:36,type:'SCALAR'}]};
 let json=Buffer.from(JSON.stringify(gltf)); json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
 const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
 const url=`/models/library/${spec.id}.glb`; await fs.writeFile('public'+url,Buffer.concat([header,json,bh,bin]));
 library.push({id:spec.id,name:spec.name,url,realHeight:spec.height,source:'schematic'});
}
await fs.writeFile('public/models/library.json',JSON.stringify(library,null,2)+'\n');
