import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { AbstractViewContribution, FrontendApplication, codicon } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common';
import axios from 'axios';
import { ImportItlingoCloudDocuments } from './itlingo-itoi-menucontribution';
import { createLogger } from './logger';

const log = createLogger('cloud-view');

/**
 * Activity-bar view that offers a persistent entry point for importing
 * documents from the itlingo cloud workspace. Unlike the Getting Started page,
 * this view always remains reachable from the left activity bar.
 *
 * The import action is gated behind the workspace write permission: read-only
 * users see the action disabled (the backend enforces the same rule).
 */
@injectable()
export class ItlingoCloudWidget extends ReactWidget {

    static readonly ID = 'itlingo.cloud.widget';
    static readonly LABEL = 'ITLingo Cloud';

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    protected canWrite = false;

    @postConstruct()
    protected init(): void {
        this.id = ItlingoCloudWidget.ID;
        this.title.label = ItlingoCloudWidget.LABEL;
        this.title.caption = ItlingoCloudWidget.LABEL;
        this.title.iconClass = codicon('cloud-download');
        this.title.closable = true;
        this.update();
        this.refreshPermission();
    }

    /**
     * Resolve whether the current user can import (write access) and refresh.
     */
    protected async refreshPermission(): Promise<void> {
        try {
            const response = await axios.get<any>('/getWorkspace', { withCredentials: true, headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Expires': '0',
            } });
            this.canWrite = response?.data?.readonly === false;
        } catch (e: any) {
            log.warn("could not resolve workspace permissions", { err: e?.message });
            this.canWrite = false;
        }
        this.update();
    }

    protected render(): React.ReactNode {
        return <div className='itlingo-cloud-container'>
            <h3 className='itlingo-cloud-header'>
                <i className={codicon('cloud')}></i>
                <span>{ItlingoCloudWidget.LABEL}</span>
            </h3>
            <p className='itlingo-cloud-description'>
                Import documents from your itlingo cloud workspace into this project.
            </p>
            <button
                className='theia-button itlingo-cloud-button'
                disabled={!this.canWrite}
                title={this.canWrite
                    ? 'Import itlingo cloud documents'
                    : 'Importing is only available for users with write access.'}
                onClick={() => this.commandRegistry.executeCommand(ImportItlingoCloudDocuments.id)}>
                Import itlingo cloud documents
            </button>
            {!this.canWrite && <p className='itlingo-cloud-readonly-note'>
                Importing is only available for users with write access.
            </p>}
        </div>;
    }
}

export const ITLINGO_CLOUD_TOGGLE_COMMAND_ID = 'itlingoCloud:toggle';

/**
 * Registers the {@link ItlingoCloudWidget} as a left activity-bar view and
 * docks it on first layout so the icon is always present.
 */
@injectable()
export class ItlingoCloudViewContribution extends AbstractViewContribution<ItlingoCloudWidget> {

    constructor() {
        super({
            widgetId: ItlingoCloudWidget.ID,
            widgetName: ItlingoCloudWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 500
            },
            toggleCommandId: ITLINGO_CLOUD_TOGGLE_COMMAND_ID
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ reveal: false });
    }
}
