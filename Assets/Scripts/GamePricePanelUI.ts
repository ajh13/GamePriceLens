import Event,{PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {Billboard} from "InteractionKit.lspkg/Components/Interaction/Billboard/Billboard"
import {BackPlate} from "UIKit.lspkg/Scripts/BackPlate"
import {Button} from "UIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "UIKit.lspkg/Scripts/Components/Content/ElementContent"
import {TextInputField} from "UIKit.lspkg/Scripts/Components/TextInputField/TextInputField"
import {FlexLayout} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout"
import {FlexItem} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem"
import {FlexDirection,FlexAlign,FlexJustify} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import {IMAGE_MATERIAL_ASSET,UNIT_PLANE_MESH_ASSET} from "UIKit.lspkg/Scripts/Utility/Assets"

@component
export class GamePricePanelUI extends BaseScriptComponent {
 private scanEvent=new Event<void>()
 private searchEvent=new Event<string>()
 private status!:Text
 private scanContent!:ElementContent
 private scanButton!:Button
 private input!:TextInputField
 private webVisual!:RenderMeshVisual
 private surface!:SceneObject
 private browser:WebPageTextureProvider|null=null
 private pendingUrl=""
 private ready=false
 private started=false
 private alive=true
 private lastTouch=new vec2(0.5,0.5)
 get onScan():PublicApi<void>{return this.scanEvent.publicApi()}
 get onSearch():PublicApi<string>{return this.searchEvent.publicApi()}
 onAwake():void{
  this.sceneObject.createComponent("Component.Canvas")
  this.sceneObject.createComponent(Billboard.getTypeName())
  const plate=this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
  plate.size=new vec2(44,62);plate.style="dark"
  const column=this.layout(this.sceneObject,44,62,false)
  this.label(column,"GAME PRICE",40,3.5,58)
  this.status=this.label(column,"Point at a barcode, case, cartridge or disc",40,3,34)
  const actions=this.layout(column,40,4.5,true)
  const scan=this.button(actions,"Scan game",19,()=>this.scanEvent.invoke())
  this.scanButton=scan.button;this.scanContent=scan.content
  this.button(actions,"Back",9,()=>{if(this.ready&&this.browser?.canGoBack)this.browser.goBack()})
  this.button(actions,"Reload",10,()=>{if(this.ready)this.browser?.reload()})
  const row=this.layout(column,40,4.5,true)
  this.input=this.item(row,29,4.5).createComponent(TextInputField.getTypeName()) as TextInputField
  this.input.size=new vec3(29,4.5,1);this.input.placeholderText="Game title + console or UPC"
  this.button(row,"Search",10,()=>this.searchEvent.invoke(this.input.text))
  this.surface=this.item(column,40,40);this.surface.name="PriceChartingWebSurface"
  const button=this.surface.createComponent(Button.getTypeName()) as Button
  button.size=new vec3(40,40,0.2);button.initialize()
  const display=global.scene.createSceneObject("PriceChartingPage");display.setParent(this.surface)
  display.getTransform().setLocalPosition(new vec3(0,0,0.3))
  display.getTransform().setLocalScale(new vec3(40,40,1))
  this.webVisual=display.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
  this.webVisual.mesh=UNIT_PLANE_MESH_ASSET
  this.webVisual.mainMaterial=IMAGE_MATERIAL_ASSET.clone()
  this.webVisual.mainPass.baseColor=new vec4(1,1,1,1);this.webVisual.enabled=false
  button.onTriggerDown.add(e=>this.touch(e,TouchState.Began))
  button.interactable.onTriggerUpdate.add(e=>this.touch(e,TouchState.Moved))
  button.onTriggerUp.add(e=>this.touch(e,TouchState.Ended))
  button.onTriggerEndOutside.add(e=>this.touch(e,TouchState.Cancelled))
  button.onTriggerCanceled.add(e=>this.touch(e,TouchState.Cancelled))
  this.createEvent("OnDestroyEvent").bind(()=>{this.alive=false;if(this.ready)this.browser?.stop()})
 }
 openUrl(url:string):void{
  if(!url.startsWith("https://www.pricecharting.com/"))throw new Error("Unsupported price source")
  this.pendingUrl=url
  if(this.ready){this.browser!.loadUrl(url);return}
  if(this.started)return
  this.started=true
  this.setStatus("Starting PriceCharting web view…")
  const watchdog=this.createEvent("DelayedCallbackEvent")
  watchdog.bind(()=>{
   if(!this.ready)this.setStatus("Web view did not start. Restart Lens on SPECS.",true)
  });watchdog.reset(15)
  try{
  const internet:InternetModule=require("LensStudio:InternetModule")
  internet.createWebView(InternetModule.createWebViewOptions(new vec2(1000,1000)),texture=>{
   if(!this.alive)return
   print("GamePrice WebView created")
   this.browser=texture.control as WebPageTextureProvider;this.webVisual.mainPass.baseTex=texture
   this.webVisual.enabled=true
   this.browser.onReady.add(()=>{
    if(!this.alive)return
    watchdog.enabled=false
    print("GamePrice WebView ready")
    this.ready=true;this.webVisual.enabled=true;this.browser!.loadUrl(this.pendingUrl)
    this.setStatus("PriceCharting • confirm game and condition")
   })
  },()=>{if(!this.alive)return;watchdog.enabled=false;this.started=false;this.setStatus("Web view unavailable. Check connection and retry.",true)})
  }catch(e){
   watchdog.enabled=false;this.started=false
   this.setStatus("Web view unavailable. Check Experimental API settings.",true)
   console.warn("[GamePrice] WebView startup failed: "+String(e).slice(0,160))
  }
 }
 setQuery(query:string):void{this.input.text=query}
 setStatus(message:string,error=false):void{
  this.status.text=message;this.status.textFill.color=error?new vec4(1,0.5,0.4,1):new vec4(1,1,1,1)
 }
 setBusy(busy:boolean):void{this.scanContent.text=busy?"Scanning…":"Scan game";this.scanButton.inputPaused=busy}
 private touch(event:InteractorEvent,state:TouchState):void{
  if(!this.ready||!this.browser)return
  event.stopPropagation()
  const hit=event.interactor.targetHitPosition
  if(hit){
   const p=this.surface.getTransform().getInvertedWorldTransform().multiplyPoint(hit)
   this.lastTouch=new vec2(Math.max(0,Math.min(1,p.x/40+0.5)),Math.max(0,Math.min(1,0.5-p.y/40)))
  }
  this.browser.touch(0,state,this.lastTouch.x,this.lastTouch.y)
 }
 private item(parent:SceneObject,w:number,h:number):SceneObject{
  const o=global.scene.createSceneObject("LayoutItem");o.setParent(parent)
  o.getTransform().setLocalPosition(new vec3(0,0,0.03))
  const item=o.createComponent(FlexItem.getTypeName()) as FlexItem
  item.overrideWidth=w;item.overrideHeight=h;item.flexShrink=0
  return o
 }
 private layout(parent:SceneObject,w:number,h:number,row:boolean):SceneObject{
  const o=this.item(parent,w,h), flex=o.createComponent(FlexLayout.getTypeName()) as FlexLayout
  flex.onInitialized.add(()=>{
   flex.width=w;flex.height=h;flex.direction=row?FlexDirection.Row:FlexDirection.Column
   flex.alignItems=FlexAlign.Center;flex.justifyContent=FlexJustify.Center
   flex.rowGap=0.7;flex.columnGap=0.7
  })
  return o
 }
 private button(parent:SceneObject,label:string,w:number,action:()=>void):{button:Button;content:ElementContent}{
  const o=this.item(parent,w,4.5);o.name=label
  const button=o.createComponent(Button.getTypeName()) as Button
  button.size=new vec3(w,4.5,0.5);button.initialize()
  const content=o.createComponent(ElementContent.getTypeName()) as ElementContent
  content.text=label;content.textSize=36;button.onTriggerUp.add(action)
  return {button,content}
 }
 private label(parent:SceneObject,value:string,w:number,h:number,size:number):Text{
  const t=this.item(parent,w,h).createComponent("Component.Text") as Text
  t.text=value;t.size=size;t.textFill.color=new vec4(1,1,1,1)
  t.horizontalAlignment=HorizontalAlignment.Center;t.verticalAlignment=VerticalAlignment.Center
  t.horizontalOverflow=HorizontalOverflow.Shrink;t.verticalOverflow=VerticalOverflow.Shrink
  t.layoutRect=Rect.create(-w/2,w/2,-h/2,h/2);return t
 }
}
