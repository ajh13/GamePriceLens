// EAN-13 and UPC-A scanline decoder. No camera frames leave the device on this path.
const LEFT = ["3211","2221","2122","1411","1132","1231","1114","1312","1213","3112"]
const EVEN = LEFT.map(pattern => pattern.split("").reverse().join(""))
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"]

export function validBarcode(value: string): boolean {
  if (!/^(?:\d{12}|\d{13})$/.test(value)||/^0+$/.test(value)) return false
  let sum = 0
  for (let i=value.length-2, weight=3; i>=0; i--, weight=4-weight) sum += Number(value[i])*weight
  return (10-sum%10)%10 === Number(value[value.length-1])
}

function digit(widths: number[], patterns: string[]): {value: number; error: number} {
  const unit = widths.reduce((sum,n)=>sum+n,0)/7
  let best = {value:-1,error:Infinity}
  patterns.forEach((pattern,value)=>{
    const error = widths.reduce((sum,n,i)=>sum+Math.abs(n/unit-Number(pattern[i])),0)
    if(error<best.error) best={value,error}
  })
  return best
}

export function decodeLine(gray: number[], threshold: number): string | null {
  const runs: {black:boolean; width:number}[]=[]
  for(const pixel of gray) {
    const black=pixel<threshold
    const last=runs[runs.length-1]
    if(last && last.black===black) last.width++
    else runs.push({black,width:1})
  }
  for(let start=1;start+58<runs.length;start++) {
    if(!runs[start].black) continue
    const widths=runs.slice(start,start+59).map(run=>run.width)
    const unit=(widths[0]+widths[1]+widths[2])/3
    if(unit<0.8 || runs[start-1].width<unit*5) continue
    if(!runs[start+59]||runs[start+59].black||runs[start+59].width<unit*5)continue
    const guards=[0,1,2,27,28,29,30,31,56,57,58]
    if(guards.some(i=>Math.abs(widths[i]/unit-1)>0.65)) continue
    let code="", parity="", error=0
    for(let d=0;d<6;d++) {
      const group=widths.slice(3+d*4,7+d*4)
      const odd=digit(group,LEFT), even=digit(group,EVEN)
      const selected=odd.error<=even.error?odd:even
      parity+=selected===odd?"L":"G"; code+=selected.value; error+=selected.error
    }
    const first=PARITY.indexOf(parity)
    if(first<0) continue
    for(let d=0;d<6;d++) {
      const selected=digit(widths.slice(32+d*4,36+d*4),LEFT)
      code+=selected.value; error+=selected.error
    }
    code=String(first)+code
    if(error<8 && validBarcode(code)) return code[0]==="0"?code.slice(1):code
  }
  return null
}

export function scanBarcode(texture: Texture): string | null {
  const copy=ProceduralTextureProvider.createFromTexture(texture)
  try {
    const provider=copy.control as ProceduralTextureProvider
    const width=provider.getWidth(), height=provider.getHeight()
    const votes: Record<string,number>={}
    for(const vertical of [false,true]) {
      const length=vertical?height:width
      const pixels=new Uint8Array(length*4)
      for(let fraction=0.2;fraction<=0.8;fraction+=0.06) {
        provider.getPixels(vertical?Math.floor(width*fraction):0,vertical?0:Math.floor(height*fraction),vertical?1:width,vertical?height:1,pixels)
        const gray:number[]=[]
        for(let i=0;i<length;i++) gray.push((pixels[i*4]*77+pixels[i*4+1]*150+pixels[i*4+2]*29)/256)
        let low=255,high=0
        gray.forEach(v=>{low=Math.min(low,v);high=Math.max(high,v)})
        if(high-low<45) continue
        const found=new Set<string>()
        for(const ratio of [0.4,0.55,0.7]) {
          const threshold=low+(high-low)*ratio
          const code=decodeLine(gray,threshold)||decodeLine(gray.slice().reverse(),threshold)
          if(code) found.add(code)
        }
        for(const code of found) {
          votes[code]=(votes[code]||0)+1
          if(votes[code]>=2) return code
        }
      }
    }
    return null
  } finally { /* Texture lifetime is managed by the Lens runtime. */ }
}
