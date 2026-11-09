import {VisualRecognitionProvider} from "../Scripts/VisualRecognitionProvider"
/** Opt-in cloud integration probe. Only the explicitly wired fixture is sent. */
@component
export class RecognitionProbe extends BaseScriptComponent {
 @input fixture!:Texture
 onAwake():void{
  this.createEvent("OnStartEvent").bind(()=>{
   new VisualRecognitionProvider().recognize(this.fixture).then(match=>{
    console.log("[RecognitionProbe] result: "+JSON.stringify(match))
   }).catch(error=>console.log("[RecognitionProbe] rejected: "+String(error).slice(0,240)))
  })
 }
}
