import { JsonRpcServer } from '@theia/core';
import {  injectable } from '@theia/core/shared/inversify';
import { createLogger } from './logger';

const log = createLogger('itoi-server');

const timeoutMS = 10*1000;

const openedFile: Map<string, string[]> = new Map<string, string[]>();
const userOpenedFiles: Map<string, string[]> = new Map<string, string[]>();
const usersAlive: Map<string, Date> = new Map<string, Date>();


setInterval(()=>{
  for(const [user, datetime] of usersAlive){
    const msBetweenDates = (new Date()).getTime() - datetime.getTime();
    if(msBetweenDates>timeoutMS){
      log.info("user timed out", { username: user, idleMs: msBetweenDates });
      timeoutUser(user);
    }
  }
}, 10*1000);


export interface ItoiClient {
    
}


export const ItoiServer = Symbol("ItoiServer");
export interface ItoiServer extends JsonRpcServer<ItoiClient> {
    fileOpened(fileUri: string): void;
    fileClosed(fileUri: string): void;
    setUsername(username: string): void;
    getUsersWithFileOpen(fileUri: string): Promise<string[]>;
    userPing(): void;
}


//revamp  concurrency
//Passar o username para o client (no get workspace) FEITO
//on open document mandar o doc para o ItoiServer
//  - Na resposta enviar a lista de user que também tem o doc aberto FEITO

//Ter um sistem de ImAlive para cada user e dado timeout de 10segundos remover da lista FEITO

//On open document mostrar ao user que users têm o doc aberto

//Map de doc -> lista de users
//Map de user -> lista de docs
//lista de pairs user/last timeout
//metodo de ping
//ter uma rotina que 10 em 10 segundos ve se algum user está timedout


@injectable()
export class ItoiServerNode implements ItoiServer {


  // @inject(SwitchWSBackendContribution)
  // protected readonly backendContrib: SwitchWSBackendContribution;

  client: ItoiClient | undefined;
  username: string = "";
  getClient?(): ItoiClient | undefined {
        return this.client;
    }
  dispose(): void {}

  setClient(client: ItoiClient | undefined): void {
    this.client = client;
  }

  fileOpened(fileUri: string): void {
    log.debug("file opened", { username: this.username, fileUri });
    let readers = openedFile.get(fileUri);
     if (readers){
      readers
      if (!(readers.includes(this.username))){
        readers.push(this.username);
        openedFile.set(fileUri, readers);
        addFileToUser(this.username, fileUri);
      }
     } else {
      openedFile.set(fileUri, [this.username]);
     }
  }

  fileClosed(fileUri: string): void {
    let readers = openedFile.get(fileUri);
     if (readers){
      if (( readers.includes(this.username))){
        let removeIndex = readers.indexOf(this.username);
        log.debug("removing user from readers", { username: this.username, fileUri, removeIndex, readers: readers.slice() });
        readers.splice(removeIndex, 1);
        log.debug("readers after close", { fileUri, readers: readers.slice() });
        openedFile.set(fileUri, readers);
        removeFileToUser(this.username, fileUri);
      }
     }
  }

  async isFileOpen(fileUri: string): Promise<number> {
    // console.log("isFileOpen?" + fileUri + openedFile.get(fileUri));
    // let readers = openedFile.get(fileUri);
    // if (readers){
    //   return readers;
    // }
    return 0;



  }
  setUsername(username: string): void{
   log.info("username bound to itoi-server session", { username });
   this.username = username;
  }

  userPing(): void {
    if (this.username.length>0) {
      log.trace("user ping", { username: this.username });
      usersAlive.set(this.username, new Date());
    }
  }

  async getUsersWithFileOpen(fileUri: string): Promise<string[]> {
    let users = openedFile.get(fileUri);
    if(users) return users
    return [];
  }
}

function addFileToUser(username: string, fileUri: string) {
  let files = userOpenedFiles.get(username);
  if(files){
    if(!(files.includes(fileUri))){
      files.push(fileUri);
      userOpenedFiles.set(username, files);
    }
  } else {
    userOpenedFiles.set(username, [fileUri]);
  }
}

function removeFileToUser(username: string, fileUri: string) {
  let files = userOpenedFiles.get(username);
  if(files){
    if((files.includes(fileUri))){
      let removeIndex = files.indexOf(fileUri);
      files.splice(removeIndex, 1);
      userOpenedFiles.set(fileUri, files);
    }
  }
}

function timeoutUser(username: string){
  let files = userOpenedFiles.get(username);
  if(files){
    for(const file in files){
      let listofUsers = openedFile.get(file);
      if (listofUsers){
        let removeindex = listofUsers.indexOf(username);
        listofUsers.splice(removeindex, 1);
        openedFile.set(file, listofUsers);
      }
    }
  }
  userOpenedFiles.delete(username);
  usersAlive.delete(username);
}

//   clientTiny = new TinyliciousClient();
//   sharedString : SharedString;
//   fileUri: string;
//   clients: string[];

//   async getGreeterName(): Promise<string> {
//     return "SharedStringServerNode";
//   }

//   greet(greetings: string): void {
//     this.client?.onGreet(greetings);
//   }

//   async joinCollab(id: string, fileUri: string): Promise<string> {
//     const { container } = await this.clientTiny.getContainer(id, containerSchema);
//     this.sharedString = container.initialObjects.sessionString as SharedString;
//     this.fileUri = fileUri;
//     this.sharedString.on("sequenceDelta", (ev: SequenceDeltaEvent) => {
//       console.log("fired sharedString change: " + ev.isLocal);
//       if (ev.isLocal) {
//           return;
//       }

//       try {
//           for (const range of ev.ranges) {
//               const segment = range.segment;
//               if (TextSegment.is(segment)) {
//                   switch (range.operation) {
//                       case MergeTreeDeltaType.INSERT: {
//                         this.client?.onSharedStringChange("insert", range.position, segment.text, this.fileUri);
//                           break;
//                       }
//                       case MergeTreeDeltaType.REMOVE: {
//                         this.client?.onSharedStringChange("remove", range.position, segment.text, this.fileUri);
//                       break;
//                       }
//                       default:
//                           break;
//                   }
//               }
//           }
//       } finally {
//           //ignoreModelContentChanges = false;
//       }
//     });
//     return this.sharedString.getText();
//   }

//   async startCollab(document: string, fileUri: string){
//     console.log("startCollab");
//     console.log(document);
//     this.fileUri = fileUri;
//     const { container } = await this.clientTiny.createContainer(containerSchema);
//     this.sharedString = container.initialObjects.sessionString as SharedString;
//     this.sharedString.insertText(0,document);
//     const id = await container.attach();
//     connectedClients.add(id);

//     this.sharedString.on("sequenceDelta", (ev: SequenceDeltaEvent) => {
//       console.log("fired sharedString change: " + ev.isLocal);
//       if (ev.isLocal) {
//           return;
//       }

//       try {
//           for (const range of ev.ranges) {
//               const segment = range.segment;
//               if (TextSegment.is(segment)) {
//                   switch (range.operation) {
//                       case MergeTreeDeltaType.INSERT: {
//                         this.client?.onSharedStringChange("insert", range.position, segment.text, this.fileUri);
//                           break;
//                       }
//                       case MergeTreeDeltaType.REMOVE: {
//                         this.client?.onSharedStringChange("remove", range.position, segment.text, this.fileUri);
//                       break;
//                       }
//                       default:
//                           break;
//                   }
//               }
//           }
//       } finally {
//           //ignoreModelContentChanges = false;
//       }
//   });



//     console.log("got document");
//     console.log(this.sharedString.getText());
//     return id;
//   }


//     getDocumentChange(text: string, rangeOffset: number, rangeLength: number): void {
//         if (text) {
//             if (rangeLength === 0) {
//                 this.sharedString.insertText(rangeOffset, text);
//             } else {
//                 this.sharedString.replaceText(
//                     rangeOffset,
//                     rangeOffset + rangeLength,
//                     text,
//                 );
//             }
//         } else {
//             this.sharedString.removeText(
//                 rangeOffset,
//                 rangeOffset + rangeLength,
//             );
//         }
//         console.log("got document change");
//         console.log(this.sharedString.getText());
//     }






// }


// export class SharedServer {
    //Start Collaboration
    // async startCollabSession(editorText: string){
    //     const { container } = await client.createContainer(containerSchema);
    //     //let sessionid = randomUUID();
    //     (container.initialObjects.sessionMap as SharedString).insertText(0,editorText);
    //     const id = await container.attach();
    //     return id;
    // }



    // codeEditor.onDidChangeModelContent((e) => {
    //     // eslint-disable-next-line @typescript-eslint/no-floating-promises
    //     monaco.languages.typescript.getTypeScriptWorker().then(async (worker) => {
    //         await worker(codeModel.uri).then(async (client) => {
    //             await client.getEmitOutput(codeModel.uri.toString()).then((r) => {
    //                 outputModel.setValue(r.outputFiles[0].text);
    //             });
    //         });
    //     });

    //     if (ignoreModelContentChanges) {
    //         return;
    //     }

    //     for (const change of e.changes) {
    //         if (change.text) {
    //             if (change.rangeLength === 0) {
    //                 sharedString.insertText(change.rangeOffset, change.text);
    //             } else {
    //                 sharedString.replaceText(
    //                     change.rangeOffset,
    //                     change.rangeOffset + change.rangeLength,
    //                     change.text,
    //                 );
    //             }
    //         } else {
    //             sharedString.removeText(
    //                 change.rangeOffset,
    //                 change.rangeOffset + change.rangeLength,
    //             );
    //         }
    //     }
    // });

