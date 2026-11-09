import {GamePricePanelUI} from "./GamePricePanelUI"
import {GameRecognition} from "./GamePriceTypes"
import {VisualRecognitionProvider,priceChartingSearchUrl} from "./VisualRecognitionProvider"
import {scanBarcode,validBarcode} from "./BarcodeScanner"
@component
export class GamePriceMain extends BaseScriptComponent{
 @input panel!:GamePricePanelUI
 @input verificationQuery:string=""
 private camera:CameraModule=require("LensStudio:CameraModule")
 private recognizer=new VisualRecognitionProvider()
 private busy=false
 private generation=0
 private live:Texture|null=null
 private alive=true
 private cancelCapture:(()=>void)|null=null
 onAwake():void{
  this.createEvent("OnStartEvent").bind(()=>{
   this.panel.onScan.add(()=>{void this.scan()})
   this.panel.onSearch.add(query=>this.search(query))
   this.panel.setStatus("Point at a barcode, case, cartridge or disc")
   if(this.verificationQuery)this.search(this.verificationQuery)
  })
  this.createEvent("OnDestroyEvent").bind(()=>{this.alive=false;this.generation++;this.cancelCapture?.();this.cancelCapture=null;this.live=null})
 }
 public async scan():Promise<void>{
  if(this.busy||!this.alive)return
  this.busy=true;this.panel.setBusy(true)
  const generation=++this.generation,timer=this.createEvent("DelayedCallbackEvent")
  timer.bind(()=>{
   if(this.generation!==generation)return
   this.generation++;this.busy=false;this.panel.setBusy(false)
   this.cancelCapture?.();this.cancelCapture=null
   this.panel.setStatus("Scan timed out. Check connection and try again.",true)
  });timer.reset(25)
  try{
   this.panel.setStatus("Hold still • capturing the label")
   const texture=await this.capture()
   if(this.generation!==generation)return
   this.panel.setStatus("Checking barcode…")
   let code:string|null=null
   try{code=scanBarcode(texture)}catch(e){console.warn("[GamePrice] Barcode pixels unavailable")}
   let match:GameRecognition
   if(code)match={source:"barcode",title:code,upc:code,confidence:1}
   else{
    this.panel.setStatus("Reading label • sending image for recognition")
    match=await this.recognizer.recognize(texture)
   }
   if(this.generation!==generation)return
   this.panel.setQuery(match.upc||[match.title,match.platform].filter(Boolean).join(" "))
   this.panel.setStatus(code?"Barcode found • opening prices":"Check title and edition • opening prices")
   this.panel.openUrl(priceChartingSearchUrl(match))
   console.log("[GamePrice] Real scan completed via "+match.source)
  }catch(e){
   if(this.generation===generation)this.panel.setStatus("Scan failed. Try a clearer label or enter the title.",true)
   if(this.alive)console.warn("[GamePrice] Scan failed: "+String(e).slice(0,160))
  }finally{
   if(this.alive)this.removeEvent(timer)
   if(this.alive&&this.generation===generation){this.busy=false;this.panel.setBusy(false)}
  }
 }
 public search(query:string):void{
  if(!this.alive)return
  const text=query.trim().slice(0,240)
  if(!text){this.panel.setStatus("Enter game title, console, or barcode",true);return}
  this.generation++;this.busy=false;this.panel.setBusy(false)
  this.cancelCapture?.();this.cancelCapture=null
  const digits=text.replace(/[\s-]/g,"")
  if(/^\d+$/.test(digits)&&!validBarcode(digits)){
   this.panel.setStatus("Check barcode digits and try again",true);return
  }
  this.panel.setStatus("Opening PriceCharting • select the matching edition")
  this.panel.openUrl(priceChartingSearchUrl({source:"manual",title:text,confidence:1,upc:validBarcode(digits)?digits:undefined}))
 }
 private async capture():Promise<Texture>{
  if(!global.deviceInfoSystem.isEditor()){
   const request=CameraModule.createImageRequest()
   return (await this.camera.requestImage(request)).texture
  }
  if(!this.live){
   const request=CameraModule.createCameraRequest();request.cameraId=CameraModule.CameraId.Default_Color
   this.live=this.camera.requestCamera(request)
  }
  const texture=this.live,provider=texture.control as CameraTextureProvider
  await new Promise<void>((resolve,reject)=>{
   const reg=provider.onNewFrame.add(()=>{
    provider.onNewFrame.remove(reg);this.cancelCapture=null;resolve()
   })
   this.cancelCapture=()=>{provider.onNewFrame.remove(reg);reject(new Error("Capture cancelled"))}
  });return texture
 }
}
