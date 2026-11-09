import type {GameRecognition} from "./GamePriceTypes"
import {validBarcode} from "./BarcodeScanner"

/** Pure validation boundary: model output is untrusted, not a confirmed catalog match. */
export function parseRecognition(text:string):GameRecognition {
 const json=text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"")
 let value:unknown
 try{value=JSON.parse(json)}catch{throw new Error("Recognition returned invalid JSON")}
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Recognition returned no game")
 const result=value as Record<string,unknown>
 if(typeof result.title!=="string"||!result.title.trim()||result.title.length>200||
    typeof result.platform!=="string"||!result.platform.trim()||result.platform.length>80||
    typeof result.confidence!=="number"||!Number.isFinite(result.confidence)||result.confidence<0.75||result.confidence>1)
  throw new Error("No clear title and platform. Try a clearer label or search manually.")
 const upc=typeof result.upc==="string"&&validBarcode(result.upc)?result.upc:undefined
 const format=result.format==="case"||result.format==="cartridge"||result.format==="disc"?result.format:"unknown"
 return {source:"visual",title:result.title.trim(),platform:result.platform.trim(),format,confidence:result.confidence,upc}
}

export function priceChartingSearchUrl(recognition:GameRecognition):string {
 const code=recognition.upc&&validBarcode(recognition.upc)?recognition.upc:undefined
 const query=code||[recognition.title,recognition.platform].filter(Boolean).join(" ").trim()
 if(!query||query.length>300)throw new Error("Enter a game title and console or valid UPC/EAN")
 return "https://www.pricecharting.com/search-products?type=prices&q="+encodeURIComponent(query)
}
