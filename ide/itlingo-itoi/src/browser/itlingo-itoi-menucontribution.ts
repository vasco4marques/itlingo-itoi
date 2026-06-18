import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution,MessageService, CommandHandler, CommandRegistry, MenuContribution, MenuModelRegistry, Command, QuickPickItem } from '@theia/core/lib/common';
import { KeybindingContribution, KeybindingRegistry, QuickInputService } from '@theia/core/lib/browser';
import { createLogger } from './logger';
import { GIT_COMMANDS, GIT_MENUS } from '@theia/git/lib/browser/git-contribution';
import { WorkspaceCommands } from '@theia/workspace/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser'
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';

import {
    TabBarToolbarContribution,
    TabBarToolbarItem,
    TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import axios from 'axios';
// import { SharedStringServer } from '../node/SharedStringServer';
// import { SharedStringClientImpl } from './SharedStringClientImpl';

type GitUser = {
    email: string,
    username: string,
    accessCode: string,
    repository: string
}

const gitUser: GitUser = {
    email: localStorage.getItem("gitEmail") ?? '',
    username: localStorage.getItem("gitUsername") ?? '',
    accessCode: localStorage.getItem("gitAccessCode") ?? '',
    repository: localStorage.getItem("gitRepo") ?? ''
};

export const StartCollab: Command = {
    id: 'itoicollab.startCollab',
    label: 'Start Collaboration'
};

export const JoinCollab : Command = {
    id: 'itoicollab.joinCollab',
    label: 'Join Collaboration'
};

export const StopCollab : Command = {
    id: 'itoicollab.stopCollab',
    label: 'Stop Collaboration'
};

export const ImportItlingoCloudDocuments: Command = {
    id: 'itlingo.import.cloudDocuments',
    label: 'Import itlingo cloud documents'
};

const importLog = createLogger('cloud-import');






@injectable()
export class TheiaExampleMenuContribution implements MenuContribution, TabBarToolbarContribution {
    @inject(CommandRegistry) protected readonly  commands: CommandRegistry;

    constructor(
        
    ){
    }


    protected asSubMenuItemOf(submenu: { group: string; label: string; menuGroups: string[]; }, groupIdx: number = 0): string {
        return submenu.group + '/' + submenu.label + '/' + submenu.menuGroups[groupIdx];
    }

    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        const registerItem = (item: TabBarToolbarItem) => {
            const commandId = item.command;
            const id = '__git.tabbar.toolbar.' + commandId;
            const command = this.commands.getCommand(commandId);
            this.commands.registerCommand({ id, iconClass: command && command.iconClass }, {
                execute: ( ...args) =>  this.commands.executeCommand(commandId, ...args),
                isEnabled: ( ...args) => this.commands.isEnabled(commandId, ...args),
            });
            item.command = id;
            registry.registerItem(item);
        };

        registerItem({
            id: GIT_COMMANDS.CLONE.id,
            command: GIT_COMMANDS.CLONE.id,
            tooltip: GIT_COMMANDS.CLONE.label,
            group: this.asSubMenuItemOf(GIT_MENUS.SUBMENU_PULL_PUSH, 0)
        });

    }
    async registerMenus(menus: MenuModelRegistry): Promise<void> {
        
    }
}



@injectable()
export class TheiaExampleCommandContribution implements CommandContribution {

    @inject(QuickInputService)
    protected readonly quickInputService: QuickInputService;
    @inject(MessageService) 
    protected readonly  messageService: MessageService;
    @inject(CommandRegistry) 
    protected readonly  commands: CommandRegistry;
    @inject(EditorManager)
    protected readonly editorManager: EditorManager;
    @inject(FileNavigatorContribution)
    protected readonly fileNavigatorContribution: FileNavigatorContribution;
    constructor(){}


   async registerCommands(commands: CommandRegistry): Promise<void> {
        
        // commands.unregisterCommand(GIT_COMMANDS.PULL);
        // commands.unregisterCommand(GIT_COMMANDS.PULL_DEFAULT);
        commands.unregisterCommand(GIT_COMMANDS.PULL_DEFAULT_FAVORITE);
        // commands.unregisterCommand(GIT_COMMANDS.PUSH);
        // commands.unregisterCommand(GIT_COMMANDS.PUSH_DEFAULT);
        commands.unregisterCommand(GIT_COMMANDS.PUSH_DEFAULT_FAVORITE);
        commands.unregisterCommand(GIT_COMMANDS.CLONE);
        commands.unregisterCommand(GIT_COMMANDS.FETCH);
        commands.unregisterCommand(WorkspaceCommands.OPEN_WORKSPACE);
        commands.unregisterCommand(WorkspaceCommands.OPEN_RECENT_WORKSPACE);
        commands.unregisterCommand(WorkspaceCommands.ADD_FOLDER);
        commands.unregisterCommand(WorkspaceCommands.OPEN_FOLDER);
        commands.unregisterCommand(WorkspaceCommands.CLOSE);
        


        commands.registerCommand(WorkspaceCommands.OPEN_WORKSPACE, {isEnabled:()=>{ return false}, execute:()=>{}});
        commands.registerCommand(WorkspaceCommands.OPEN_FOLDER, {isEnabled:()=>{ return false}, execute:()=>{}});
        commands.registerCommand(WorkspaceCommands.CLOSE, {isEnabled:()=>{ return false}, execute:()=>{}});
        commands.registerCommand(WorkspaceCommands.OPEN_RECENT_WORKSPACE, {isEnabled:()=>{ return false}, execute:()=>{}});
        commands.registerCommand(WorkspaceCommands.ADD_FOLDER, {isEnabled:()=>{ return false}, execute:()=>{}});

        GIT_MENUS.SUBMENU_PULL_PUSH.label = "Extended Actions";
        GIT_COMMANDS.FETCH.label = "Clone...";
        
        GIT_COMMANDS.PULL_DEFAULT_FAVORITE.label = "New branch";
        GIT_COMMANDS.PUSH_DEFAULT_FAVORITE.label = "Checkout branch";

        commands.registerCommand(GIT_COMMANDS.FETCH, {
            execute: () => { 
                this.myGitClone(); 
            } 
        } as CommandHandler);
        // commands.registerCommand(GIT_COMMANDS.PUSH, {
        //     execute:  () => { this.myGitPush(); } 
        // } as CommandHandler);
        commands.registerCommand(GIT_COMMANDS.PULL_DEFAULT_FAVORITE, {
            execute:  () => { this.myGitBranch(); } 
        } as CommandHandler);
        // commands.registerCommand(GIT_COMMANDS.PUSH_DEFAULT_FAVORITE, {
        //     execute:  () => { this.myGitCheckout(); } 
        // } as CommandHandler);
        // commands.registerCommand(GIT_COMMANDS.PULL, {
        //     execute: () => { this.myGitPull(); } 
        // } as CommandHandler);
        // commands.registerCommand(StartCollab, {
        //     execute: () => { 
        //         this.messageService.info("Start!");
        //         commands.executeCommand('setContext', 'itoi-collab.showStop', true);
        //         this.sharedStringClientImpl.startCollab() }
        // });
        // commands.registerCommand(StopCollab, {
        //     execute: () => {
        //         this.messageService.info("Stop!");
        //         commands.executeCommand('setContext', 'itoi-collab.showStop', false);
        //         this.stopCollab(); }
        // });
        // commands.registerCommand(JoinCollab, {
        //     execute: () => { 
        //         this.messageService.info("Join!");
        //         commands.executeCommand('setContext', 'itoi-collab.showStop', true);
        //         this.sharedStringClientImpl.joinCollab(); 
        //     }
        // });

        commands.registerCommand(ImportItlingoCloudDocuments, {
            execute: () => this.importItlingoCloudDocuments()
        } as CommandHandler);

    }

    /**
     * Force the file explorer to re-read the workspace from disk so freshly
     * imported files appear without a page reload. Retried a couple of times
     * with small delays to cover any lag between the disk write and the
     * filesystem provider seeing it.
     */
    protected async refreshExplorer(): Promise<void> {
        const delays = [0, 400, 1200];
        for (const delay of delays) {
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            try {
                await this.fileNavigatorContribution.refreshWorkspace();
                importLog.debug("refreshed explorer after import", { delay });
            } catch (e: any) {
                importLog.warn("could not refresh explorer after import", { delay, err: e?.message });
            }
        }
    }

    /**
     * Resolve whether the current user has write access to the workspace.
     * Only write users are allowed to import itlingo cloud documents.
     */
    protected async canWrite(): Promise<boolean> {
        try {
            const response = await axios.get<any>('/getWorkspace', { withCredentials: true, headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Expires': '0',
            } });
            return response?.data?.readonly === false;
        } catch (e: any) {
            importLog.warn("could not resolve workspace permissions", { err: e?.message });
            return false;
        }
    }

    /**
     * Import documents from the itlingo cloud workspace into the current project.
     * Lists the available documents, lets the user pick which to import and
     * downloads the selected ones. Gated behind the write permission check.
     */
    async importItlingoCloudDocuments(): Promise<void> {
        if (!(await this.canWrite())) {
            this.messageService.error("Importing itlingo cloud documents is only available for users with write access.");
            return;
        }
        importLog.info("requesting itlingo cloud document list");
        axios.get<any>('/setupCustom', {}).then((listOfFiles: any) => {
            importLog.debug("itlingo cloud document list response", { status: listOfFiles?.status, count: listOfFiles?.data?.namelist?.length });
            const namelist = listOfFiles?.data?.namelist ?? [];
            if (namelist.length === 0) {
                this.messageService.info("No importable itlingo cloud documents are available for this workspace.");
                return;
            }

            const selection: QuickPickItem[] = [];
            for (const ele of namelist) {
                selection.push({
                    label: "File: " + ele.name + " Type: " + ele.type,
                    id: ele.id,
                    detail: ele.name
                });
            }

            // Use a raw quick pick so that we can read every checked item:
            // showQuickPick() only resolves to a single item even with
            // canSelectMany enabled.
            const quickPick = this.quickInputService.createQuickPick<QuickPickItem>();
            quickPick.items = selection;
            quickPick.canSelectMany = true;
            quickPick.title = 'Import itlingo cloud documents';
            quickPick.placeholder = 'Select the documents to import into this workspace';

            quickPick.onDidAccept(() => {
                const picked = quickPick.selectedItems.slice();
                quickPick.hide();
                if (picked.length === 0) {
                    return;
                }
                const downloads = picked.map(item =>
                    axios.get<JSON>('/setupCustomAccepted?fileid=' + item.id + '&filename=' + encodeURIComponent(item.detail ?? ''))
                );
                Promise.all(downloads).then(async () => {
                    // The backend only resolves these requests once the files are
                    // written to disk, so refreshing now reveals them immediately
                    // without the user having to reload the explorer. Refresh a few
                    // times to absorb any filesystem-event lag in the container.
                    await this.refreshExplorer();
                    this.messageService.info("Finished setting up itlingo cloud files!");
                }).catch(() => {
                    this.messageService.error("Failed to import one or more itlingo cloud files.");
                });
            });

            quickPick.show();
        }).catch((e: any) => {
            if (e?.response?.status === 403) {
                this.messageService.error("Importing itlingo cloud documents is only available for users with write access.");
            } else {
                importLog.error("failed to list itlingo cloud documents", { err: e?.message });
                this.messageService.error("Failed to retrieve itlingo cloud documents.");
            }
        });
    }
    myGitCheckout() {
        let inputBox1 = this.quickInputService.createInputBox();
        inputBox1.description = "Please insert the branch name to checkout:"
        inputBox1.placeholder = "Checkout branch"
        inputBox1.value = '';
        inputBox1.ignoreFocusOut = true;
        inputBox1.onDidAccept(() => {
            axios.get("/gitCheckout", {params:{ data: inputBox1.value }, withCredentials: true, headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Expires': '0',
              } })
            .then((e) =>{
                this.messageService.info("Checkout output: " + e.data.output);
            });
            inputBox1.hide();
        });
        inputBox1.show();

   
    }
    myGitBranch() {
        let inputBox1 = this.quickInputService.createInputBox();
        inputBox1.description = "Please insert the new branch name:"
        inputBox1.placeholder = "New Branch"
        inputBox1.value = '';
        inputBox1.ignoreFocusOut = true;
        inputBox1.onDidAccept(() => {
            axios.get("/gitBranch", {params:{data:inputBox1.value }, withCredentials: true, headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Expires': '0',
              }})
            .then((e) =>{
                this.messageService.info("Branch output: " + e.data.output);
            });
            inputBox1.hide();
        });
        inputBox1.show();
    }

    myGitPull(){
        axios.get("/gitPull", {params:{ }, withCredentials: true, headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Expires': '0',
          }})
        .then((e) =>{
            this.messageService.info("Pull output: " + e.data.output);
        });
        // let repo = localStorage.getItem("gituser.repo");
        // let accessCode = localStorage.getItem("gituser.accesscode");
        // let inputBox1 = this.quickInputService.createInputBox();
        // inputBox1.description = "Please input the repository url"
        // inputBox1.placeholder = "https://github.com/username/repo.git"
        // inputBox1.value = repo ?? '';
        // inputBox1.onDidAccept(() => {
        //     localStorage.setItem("gituser.repo",inputBox1.value ?? '');
        //     let inputBox2 = this.quickInputService.createInputBox();
        //     inputBox2.description = "Please input your access code"
        //     inputBox2.placeholder = "******"
        //     inputBox2.password = true
        //     inputBox2.value = accessCode ?? '';
        //     inputBox2.onDidAccept(() => {
        //         localStorage.setItem("gituser.accesscode",inputBox2.value ?? '');
        //         let repoUrl = insertAccessCodeIntoRepo(inputBox1.value?? '', inputBox2.value?? '');
        //         axios.get("/gitPull", {params:{ repoUrl:repoUrl}});
        //         inputBox2.hide();
        //     });
        //     inputBox1.hide();
        //     inputBox2.show();
        // });
        // inputBox1.show();
    }
    myGitPush(){
        axios.get("/gitPush", {params:{ }, withCredentials: true, headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Expires': '0',
          }})
        .then((e) =>{
            this.messageService.info("Push output: " + e.data.output);
        }).catch(e=>{
            this.messageService.error("Was not able to push!");
        });
        // let repo = localStorage.getItem("gituser.repo");
        // let accessCode = localStorage.getItem("gituser.accesscode");
        // let inputBox1 = this.quickInputService.createInputBox();
        // inputBox1.description = "Please input the repository url"
        // inputBox1.placeholder = "https://github.com/username/repo.git"
        // inputBox1.value = repo ?? '';
        // inputBox1.onDidAccept(() => {
        //     localStorage.setItem("gituser.repo",inputBox1.value ?? '');
        //     let inputBox2 = this.quickInputService.createInputBox();
        //     inputBox2.description = "Please input your access code"
        //     inputBox2.placeholder = "******"
        //     inputBox2.password = true
        //     inputBox2.value = accessCode ?? '';
        //     inputBox2.onDidAccept(() => {
        //         localStorage.setItem("gituser.accesscode",inputBox2.value ?? '');
        //         let repoUrl = insertAccessCodeIntoRepo(inputBox1.value?? '', inputBox2.value?? '');
                //axios.get("/gitPush", {params:{ repoUrl:repoUrl}});
        //         inputBox2.hide();
        //     });
        //     inputBox1.hide();
        //     inputBox2.show();
        // });
        // inputBox1.show();
    }
    async myGitClone(){
        //Let the user fillout a form (email, username, access token, repo)
        let inputBox1 = this.quickInputService.createInputBox();
        inputBox1.description = "Please input your username"
        inputBox1.placeholder = "john"
        inputBox1.value = localStorage.getItem("gituser.username") ?? '';
        inputBox1.ignoreFocusOut = true;
        inputBox1.onDidAccept(() => {
            gitUser.username = inputBox1.value?.toString() ?? '';
            let inputBox2 = this.quickInputService.createInputBox();
            inputBox2.description = "Please input your access code"
            inputBox2.placeholder = "******"
            inputBox2.password = true
            inputBox2.value = localStorage.getItem("gituser.accesscode") ?? '';
            inputBox2.ignoreFocusOut = true;
            inputBox2.onDidAccept(() => {
                gitUser.accessCode = inputBox2.value?.toString() ?? '';
                let inputBox3 = this.quickInputService.createInputBox();
                inputBox3.description = "Repository url";
                inputBox3.value = localStorage.getItem("gituser.repo") ?? '';
                inputBox3.placeholder = "https://github.com/username/repo.git";
                inputBox3.password = false;
                inputBox3.ignoreFocusOut = true;
                inputBox3.onDidAccept(() => {
                    gitUser.repository = inputBox3.value?.toString() ?? '';
                    this.callCloneBatch();
                    inputBox3.hide();
                });
                inputBox2.hide();
                inputBox3.show();    
            });
            inputBox1.hide();
            inputBox2.show();
        });
        inputBox1.show();
    }

    callCloneBatch() {
        localStorage.setItem("gituser.username", gitUser.username);
        localStorage.setItem("gituser.accesscode", gitUser.accessCode);
        localStorage.setItem("gituser.repo", gitUser.repository);
        //let commandString = `${gitUser.email} ${gitUser.username} ${gitUser.accessCode} ${gitUser.repository}`
        let repoUrl = insertAccessCodeIntoRepo(gitUser.repository, gitUser.accessCode);
        gitUser.repository = repoUrl;
        let encoded = Buffer.from(JSON.stringify(gitUser)).toString("base64");
        axios.get("/cloneRepo", {params:{
            data:encoded
        } , withCredentials: true, headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Expires': '0',
          }}).then(()=>{
            this.messageService.info("Clonned Successfully!");
        });
    }


}


@injectable()
export class TheiaExampleKeybindingContribution implements KeybindingContribution {
    async registerKeybindings(keybindings: KeybindingRegistry): Promise<void> {
        //const readOnly = await getReadonly()
            // if(readOnly){
            //     keybindings.unregisterKeybinding("ctrl+v");
            //     keybindings.unregisterKeybinding("cmd+v");
            //     keybindings.unregisterKeybinding("ctrl+c");
            //     keybindings.unregisterKeybinding("cmd+c");
            // }
    }
}







function insertAccessCodeIntoRepo(repo: string, accessCode: string ) {
    return [repo.slice(0,8), accessCode, "@", repo.slice(8)].join('');
}
// async function getReadonly(): Promise<boolean>{
//     console.log("g_readonly= " + g_readOnly);
//     if(g_readOnly == undefined) {
//         const result = await axios.get<any>('/getWorkspace',{},)
//         g_readOnly = !result.data.readonly;
//         console.log("g_readonly= " + g_readOnly);
//         return g_readOnly ?? false;
//     }
//     return g_readOnly;
// }


