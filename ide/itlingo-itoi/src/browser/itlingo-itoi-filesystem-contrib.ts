import { injectable, inject } from '@theia/core/shared/inversify';
import { FileSelection } from '@theia/filesystem/lib/browser/file-selection';
import { FileSystemFrontendContribution, FileSystemCommands } from '@theia/filesystem/lib/browser/filesystem-frontend-contribution'
import { FileUploadResult } from '@theia/filesystem/lib/browser/file-upload-service';
import { environment } from '@theia/core/shared/@theia/application-package/lib/environment';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { CommandRegistry } from '@theia/core';
import { createLogger } from './logger';

const log = createLogger('fs');

@injectable()
export class ItoiFileSystemFrontendContribution extends FileSystemFrontendContribution {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(FileSystemCommands.UPLOAD, {
            isEnabled: (...args: unknown[]) => {
                return true;
            },
            isVisible: () => !environment.electron.is(),
            execute: (...args: unknown[]) => {
                const selection = this.getSelection(...args);
                return this.upload(selection);
            }
        });
    }


    protected override async upload(selection: FileSelection | undefined): Promise<FileUploadResult | undefined> {

        if(selection && selection.fileStat.isDirectory){
            log.info("upload to directory", { path: selection.fileStat.resource.toString() });
            return super.upload(selection);
        } else {
            const root = this.workspaceService.workspace?.resource;
            log.info("upload to workspace root", { root: root?.toString() });
            if(root) {
                const target = this.workspaceService.tryGetRoots()[0].resource.resolveToAbsolute()?? '';
                const fileUploadResult = await this.uploadService.upload(target);
                log.debug("upload completed", { target: target.toString() });
                return fileUploadResult;
            }

        }

    }

}