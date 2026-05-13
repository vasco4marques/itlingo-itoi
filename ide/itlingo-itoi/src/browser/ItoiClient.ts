import {  injectable } from "@theia/core/shared/inversify";
import { ItoiClient } from "../common/itoi-protocol";
import { createLogger } from "./logger";
// import { MessageService } from "@theia/core";

const log = createLogger('itoi-client');

@injectable()
export class ItoiClientNode implements ItoiClient {

    onMessageUser(message: string): void {
        log.info("message from server", { message });
    }



}


//     @inject(SharedStringServer)
//     protected readonly sharedStringServer: SharedStringServer;
//     @inject(EditorManager)
//     protected readonly editorManager: EditorManager;
//     @inject(QuickInputService)
//     protected readonly quickInputService: QuickInputService;
//     @inject(MessageService) 
//     protected readonly  messageService: MessageService;

    
//     protected editor: monaco.editor.ICodeEditor;
//     protected model: monaco.editor.ITextModel;
//     protected clientid: string;

//     //private static turnoffChangeEvent: boolean = false


   
//     getSharedStringClient(): SharedStringClient{
//         const leditor = this.editor;
//         const lmodel = this.model;
//         const sharedStringServer = this.sharedStringServer;
//         return {
//             onGreet(greetings: string): void {
//                 console.log("received greetings: " + greetings)
//             },
//             setclientid(clientid: string){
                
//             },
//             getclientid(){
                
//             },
//             onSharedStringChange(type: string, position: number, text: string, fileName: string): void {
//               let codeModel = lmodel; //= theiaCommandContrib.getEditor()?.getControl().getModel() as monaco.editor.ITextModel;
//               let codeEditor = leditor; // = theiaCommandContrib.getEditor()?.getControl() as monaco.editor.ICodeEditor;
//               if (!codeEditor || !codeModel){
//                 for(const editor of monaco.editor.getEditors()){
//                     const model = editor.getModel();
//                     if (model){
//                         if(SharedStringClientImpl.getItoiFilename(model.uri) === fileName){
//                             codeModel = model;
//                             codeEditor = editor;
//                         }
//                     }
//                 }
//               }
        
//               console.log("received sharedString change: " + text);
//               switch (type) {
//                 case "insert":
//                     const posRange1 = SharedStringClientImpl.offsetsToRange(codeModel, position, undefined);
//                     const texti = text || "";
//                     codeEditor.getModel()?.onDidChangeContent(() => {});
//                     codeEditor.executeEdits("remote", [{ range: posRange1, text: texti }]);
//                     codeEditor.getModel()?.onDidChangeContent(e => {
//                         for (const change of e.changes) {
//                             sharedStringServer.getDocumentChange(change.text, change.rangeOffset, change.rangeLength);
//                         }
//                     });
//                   break;
//                   case "remove":
//                     const posRange = SharedStringClientImpl.offsetsToRange(codeModel, position,position + text.length);
//                     const textr = "";
//                     codeEditor.getModel()?.onDidChangeContent(() => {});
//                     codeEditor.executeEdits("remote", [{ range: posRange, text: textr }]);
//                     codeEditor.getModel()?.onDidChangeContent(e => {
//                         for (const change of e.changes) {
//                             sharedStringServer.getDocumentChange(change.text, change.rangeOffset, change.rangeLength);
//                         }
//                     });
//                   break;
//                 default:
//                   break;
//               }
            
//             }   
//         } as SharedStringClient
//     }



//     startCollab(){
//         const editor = MonacoEditor.getCurrent(this.editorManager);
//         if(editor){
//             this.messageService.info("we got editor");
//             const fileUri = editor.getControl().getModel()?.uri;
//             if (fileUri) {
//                 const filename = SharedStringClientImpl.getItoiFilename(fileUri);
//                 this.messageService.info(editor.getControl().getModel()?.getValue() ?? "no data");
//                 this.sharedStringServer.startCollab(editor.getControl().getModel()?.getValue() ?? "no data", filename)
//                 .then(result => {
//                     this.messageService.info(result);
//                     editor.getControl().getModel()?.onDidChangeContent(e => {
//                             for (const change of e.changes) {
//                                 this.sharedStringServer.getDocumentChange(change.text, change.rangeOffset, change.rangeLength);
//                             }
//                     });
//                 }).catch(error => console.log("startCollab error: " + error));
//             }
//         }
//     }



//     joinCollab(){
//         const editor = MonacoEditor.getCurrent(this.editorManager);
//         const inputbox1 = this.quickInputService.createInputBox();
//         inputbox1.description = "yo ID"
//         inputbox1.onDidAccept(async ()=>{
//             if (editor){
//                 const fileUri = editor.getControl().getModel()?.uri;
//                 if (fileUri) {
//                     const filename = SharedStringClientImpl.getItoiFilename(fileUri);
//                     const collabText = await this.sharedStringServer.joinCollab(inputbox1.value ?? "nah", filename);
//                     editor.getControl().setValue(collabText);
//                     editor.getControl().getModel()?.onDidChangeContent(e => {
//                             for (const change of e.changes) {
//                                 this.sharedStringServer.getDocumentChange(change.text, change.rangeOffset, change.rangeLength);
//                             }
//                     });
//                 }
//             }
//             inputbox1.hide();
//         });
//         inputbox1.show();
        
//     }





//     static getItoiFilename(uri: monaco.Uri): string{
//       //file:///tmp/theia/workspaces/tmp/e796eac3-7fe3-46bc-b2c2-62c76dc9bb96/Workspace-DemoWorkspace/QQQQ.kappa
//       const result = uri.path.split('/').slice(7).join('/');
//       console.log("getItoiFilename: " + result);
//       return result; 
//     }

//     static offsetsToRange(codeModel: monaco.editor.ITextModel, offset1: number , offset2?: number): monaco.Range {
//         const pos1 = codeModel.getPositionAt(offset1);
//         const pos2 = typeof offset2 === "number" ? codeModel.getPositionAt(offset2) : pos1;
//         const range = new monaco.Range(
//             pos1.lineNumber,
//             pos1.column,
//             pos2.lineNumber,
//             pos2.column,
//         );
//         return range;
//     };
