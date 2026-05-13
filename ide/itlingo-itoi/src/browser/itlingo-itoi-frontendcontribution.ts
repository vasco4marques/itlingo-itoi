
import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, MessageService} from '@theia/core/lib/common';
import { FrontendApplication, AbstractViewContribution, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { GettingStartedWidget } from './itlingo-itoi-widget';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import * as monaco from '@theia/monaco-editor-core';
import { MonacoWorkspace } from "@theia/monaco/lib/browser/monaco-workspace";
import { Widget } from '@theia/core/lib/browser/widgets';
import { ILogger } from "@theia/core/lib/common";
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import  TheiaURI from '@theia/core/lib/common/uri';

import axios from 'axios';
import { ItoiServer } from '../node/ItoiServer';
import { createLogger } from './logger';
// import { SharedStringServer } from '../node/SharedStringServer';

const workspaceLog = createLogger('workspace');
const itoiClientLog = createLogger('itoi-client');

var path = '/home/theia/Workspaces';
//var itlingoCloudURL = "https://itlingocloud.herokuapp.com/";

export const TheiaExampleExtensionCommand: Command = {
    id: 'TheiaExampleExtension.command',
    label: 'Say Hello'
};


@injectable()
export class TheiaSendBdFileUpdates extends AbstractViewContribution<GettingStartedWidget>  implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    @inject(FrontendApplicationStateService)
    protected readonly stateService: FrontendApplicationStateService;
    @inject(WorkspaceService) private readonly workspaceService: WorkspaceService;
    //@inject(MonacoEditorService) private readonly monacoEditorService: MonacoEditorService,
    @inject(MonacoWorkspace) private readonly monacoWorkspace: MonacoWorkspace;
    @inject(MessageService) private readonly messageService: MessageService;
    // @inject(WorkspaceCommandContribution) private readonly workspaceCommandContribution: WorkspaceCommandContribution,
    // @inject(CommandService) private readonly commandService: CommandService,
    //@inject(CommandService) private readonly commandService: CommandService,
    @inject(ILogger) protected readonly logger: ILogger;
    @inject(ItoiServer) itoiServer: ItoiServer;
    constructor(
        
    ) { 
        super({
            widgetId: GettingStartedWidget.ID,
            widgetName: GettingStartedWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main',
            }
        });
    }

    private readonly:boolean = true;
    //private tokens:{iv: string, t: string};

    protected async switchWorkspace(path: string): Promise<void> {
        workspaceLog.info("switching workspace", { path });
        this.messageService.info(path);
         this.workspaceService.open(new TheiaURI(path), {
            preserveWindow: true
         });
    }

    private setReadOnly(){
        monaco.editor.onDidCreateEditor((codeEditor) =>{
            if(this.readonly) {
                codeEditor.updateOptions({readOnly: this.readonly});
            }
            // } else {
            //     codeEditor.onDidChangeModel(async (e) => {
            //         if (!e.newModelUrl) return 
            //         if (e.newModelUrl.scheme === 'file'){
            //             let res = await this.itoiServer.isFileOpen(e.newModelUrl?.toString()?? "");
            //             if(res > 1){
            //                 codeEditor.updateOptions({readOnly: true});
            //             }
            //         }
            //     });
            // }
        });
        
        
        if(this.readonly){
            this.shell.widgets.forEach((widget: Widget) => {
                if (['terminal','process'].includes(widget.id) || widget.id.startsWith('debug') || widget.id.startsWith('scm')) {
                    widget.dispose();
                }
        });
            //this.quickView.showItem()
            
            var xMenuItems = document.getElementById("theia-top-panel") as HTMLElement;
            xMenuItems.classList.add("extension-readOnly");
            var styleElement = document.createElement('style');


            var styles = '.p-Widget.p-Menu { ';
            styles += 'pointer-events: none; ';
            styles += 'cursor: default; ';
            styles += ' }\n';
            styles += '.p-Menu-item { ';
            styles += 'opacity: var(--theia-mod-disabled-opacity); ';
            styles += 'pointer-events: none; ';
            styles += 'cursor: default;';
            styles += ' }\n';
            styles += '.p-Menu-item[data-command="file.download"] { ';
            styles += 'opacity: 1;';
            styles += 'pointer-events: all; ';
            styles += 'cursor: pointer; ';
            styles += ' }\n';
            styles += '.p-Menu-item[data-command="core.copy"] { ';
            styles += 'opacity: 1;';
            styles += 'pointer-events: all; ';
            styles += 'cursor: pointer; ';
            styles += ' }\n';
            styles += '.p-Menu-item[data-command="code-annotation.addNote"] { ';
            styles += 'opacity: 1;';
            styles += 'pointer-events: all; ';
            styles += 'cursor: pointer; ';
            styles += ' }\n';
            // // Add the first CSS rule to the stylesheet
            styleElement.innerHTML = styles;
            document.body.appendChild(styleElement);
            // var styles = '.p-Menu-item[data-command="core.cut"] {';
            // styles += '.p-mod-active';
            // styles += '}\n';
            // sheet?.insertRule(styles, 0);


        }
    }

     private compareFoldernames(path1: string, path2: string){
         return path1.substring(path1.length-77) === path2.substring(path2.length - 77);
     }

      initialize() {
    //      setInterval(
    //        () => {
    //         axios.get('/ping').catch((err:any) =>{
    //                 if(window.confirm("You lost connection to the server, would you like to reconnect?")){
    //                     window.location.replace('/reconnect?iv=' + this.tokens.iv + '&t=' + this.tokens.t);
    //                 }
    //         });
    //        },
    // //         this.sharedStringServer
    // //           .getGreeterName()
    // //           .then(result => console.log("GreeterServer.name=" + result))
    // //           .catch(error => console.log("Failed to get greeter name", error)),
    //        2000
    //      );
       }
    configure(app: FrontendApplication): void{
        
    }
    onStart(app: FrontendApplication):void {
         workspaceLog.info("requesting workspace info");
         axios.get<JSON>('/getWorkspace',{ withCredentials: true, headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Expires': '0',
          }, },).then(
                 (response: any) => {
                    workspaceLog.info("getWorkspace response", {
                        status: response.status,
                        foldername: response.data.foldername,
                        readonly: response.data.readonly,
                        username: response.data.username,
                    });
                    var prevRoot = this.workspaceService.tryGetRoots()[0] ;

                    if (prevRoot != undefined) {
                        if (!this.compareFoldernames(response.data.foldername.toString(), prevRoot.resource.path.toString())){
                            path = '' + response.data.foldername;
                            workspaceLog.info("changing workspace", { from: prevRoot.resource.path.toString(), to: response.data.foldername });
                            this.messageService.info("Changing Workspace to:" + response.data.foldername + " PREV:" + prevRoot.resource.path);
                            this.switchWorkspace(path);
                        } else {
                            workspaceLog.debug("keeping current workspace", { foldername: prevRoot.resource.path.toString() });
                        }
                    } else {
                        path = '' + response.data.foldername;
                        workspaceLog.info("setting workspace", { to: response.data.foldername, status: response.status });
                        this.messageService.info("Setting Workspace to:" + response.data.foldername + " STATUS:" + response.status);
                        this.switchWorkspace(path);
                    }
                    this.stateService.reachedState('ready').then(
                        () => this.openView({ reveal: true })
                    );
                    this.readonly = response.data.readonly;
                    workspaceLog.debug("readonly flag", { readonly: this.readonly });
                    this.setReadOnly();
                    this.itoiServer.setUsername(response.data.username);
                    // setInterval(
                    //     () => {
                    //         this.itoiServer.userPing();
                    //     }
                    // ,10*1000);
                    this.monacoWorkspace.onDidOpenTextDocument(async (e)=> {
                        let usersList = await this.itoiServer.getUsersWithFileOpen(e.uri);
                        itoiClientLog.debug("document opened", { uri: e.uri, otherUsers: usersList });
                        if(e.uri.substring(0,4) === 'file' && usersList.length>0){
                            this.messageService.info("This document is currently open by the following users!\n" + usersList.join(' | '));

                        }
                        this.itoiServer.fileOpened(e.uri);
                    });
                    this.monacoWorkspace.onDidCloseTextDocument((e)=> {
                        itoiClientLog.debug("document closed", { uri: e.uri });
                        this.itoiServer.fileClosed(e.uri);
                    });
                 }
             ).catch((error) => {
                workspaceLog.error("getWorkspace request failed", { err: error?.message, status: error?.response?.status });
                //window.location.href = itlingoCloudURL;
             });
        this.messageService.info("Welcome to ITLingo online IDE!");

    }
}

