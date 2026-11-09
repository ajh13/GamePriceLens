import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../Scripts/BarcodeScanner.ts',import.meta.url),'utf8');
const {decodeLine,validBarcode,scanBarcode}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G=L.map(bits=>bits.split('').reverse().map(b=>b==='1'?'0':'1').join(''));
const R=L.map(bits=>bits.replace(/[01]/g,b=>b==='1'?'0':'1'));
const parity=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
function render(code,scale=3,reverse=false){
 const ean=code.length===12?'0'+code:code;
 let bits='00000000000101';
 for(let i=1;i<=6;i++)bits+=(parity[Number(ean[0])][i-1]==='L'?L:G)[Number(ean[i])];
 bits+='01010';for(let i=7;i<13;i++)bits+=R[Number(ean[i])];bits+='10100000000000';
 const row=[...bits].flatMap(b=>Array(scale).fill(b==='1'?30:220));
 return reverse?row.reverse():row;
}
for(const code of ['045496590420','4006381333931','012345678905']){
 assert(validBarcode(code));
 for(const scale of [2,3,5])for(const threshold of [85,128,180]){
  assert.equal(decodeLine(render(code,scale),threshold),code);
  const reversed=render(code,scale,true);
  assert.equal(decodeLine(reversed,threshold)||decodeLine(reversed.reverse(),threshold),code);
 }
}
assert(!validBarcode('045496590421'));
assert.equal(decodeLine(render('045496590421'),128),null);
assert.equal(decodeLine(Array(500).fill(255),128),null);
assert(!validBarcode('000000000000'));
assert(!validBarcode('12345678'));
assert.equal(decodeLine(render('045496590420').slice(0,-33),128),null);
// Exercise pixel extraction and voting, not just the individual decoder.
function texture(code,{vertical=false,reverse=false,singleRow=false,blank=false}={}){
 const row=render(code,3,reverse),w=vertical?90:row.length,h=vertical?row.length:90;
 return {control:{getWidth:()=>w,getHeight:()=>h,getPixels:(x,y,width,height,out)=>{
  for(let j=0;j<height;j++)for(let i=0;i<width;i++){
   const axis=vertical?y+j:x+i, cross=vertical?x+i:y+j;
   const value=blank||(singleRow&&cross!==18)?220:row[axis];
   const at=(j*width+i)*4;out[at]=out[at+1]=out[at+2]=value;out[at+3]=255;
  }
 }}};
}
globalThis.ProceduralTextureProvider={createFromTexture:t=>t};
for(const vertical of [false,true])for(const reverse of [false,true])assert.equal(scanBarcode(texture('045496590420',{vertical,reverse})),'045496590420');
assert.equal(scanBarcode(texture('045496590420',{singleRow:true})),null);
assert.equal(scanBarcode(texture('045496590420',{blank:true})),null);
console.log('PASS: UPC/EAN fixture decoding, scale/threshold/reverse variants, checksum rejection and blank image');
