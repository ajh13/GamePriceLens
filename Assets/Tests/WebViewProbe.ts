/** Opt-in diagnostic, disabled in the normal scene. No UIKit dependency. */
@component
export class WebViewProbe extends BaseScriptComponent {
 @input mesh!:RenderMesh
 @input material!:Material
 onAwake():void{
  this.createEvent("OnStartEvent").bind(()=>{
   const visual=this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
   visual.mesh=this.mesh;visual.mainMaterial=this.material.clone()
   visual.mainPass.baseColor=new vec4(1,1,1,1)
   const internet:InternetModule=require("LensStudio:InternetModule")
   let ready=false
   const timer=this.createEvent("DelayedCallbackEvent")
   timer.bind(()=>console.log("[WebViewProbe] ready after 15s="+ready));timer.reset(15)
   internet.createWebView(InternetModule.createWebViewOptions(new vec2(800,800)),texture=>{
    console.log("[WebViewProbe] creation callback")
    visual.mainPass.baseTex=texture
    const provider=texture.control as WebPageTextureProvider
    provider.onReady.add(()=>{
     ready=true;console.log("[WebViewProbe] ready")
     provider.loadUrl("https://www.pricecharting.com/search-products?type=prices&q=045496590420")
    })
   },error=>console.warn("[WebViewProbe] creation failed: "+error))
  })
 }
}
