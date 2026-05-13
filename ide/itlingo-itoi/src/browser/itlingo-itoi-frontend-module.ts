/**
 * Generated using theia-extension-generator
 */
import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { TheiaSendBdFileUpdates } from './itlingo-itoi-frontendcontribution';
import { GettingStartedWidget } from './itlingo-itoi-widget';
import {  TheiaExampleCommandContribution } from './itlingo-itoi-menucontribution';
import { WidgetFactory, FrontendApplicationContribution, bindViewContribution, WebSocketConnectionProvider  } from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common';

import '../../src/browser/style/index.css';
import {  ItoiServer } from '../common/itoi-protocol';
import { ItoiClientNode } from './ItoiClient';
import { ItoiFileSystemFrontendContribution } from './itlingo-itoi-filesystem-contrib';
import { FileSystemFrontendContribution } from '@theia/filesystem/lib/browser/filesystem-frontend-contribution'

export default new ContainerModule((
  bind: interfaces.Bind,
  unbind: interfaces.Unbind,
  isBound: interfaces.IsBound,
  rebind: interfaces.Rebind
) => {
    // add your contribution bindings here
    bind(ItoiFileSystemFrontendContribution).toSelf().inSingletonScope();
    rebind(FileSystemFrontendContribution).to(ItoiFileSystemFrontendContribution);
    bind(FrontendApplicationContribution).to(TheiaSendBdFileUpdates);
    bindViewContribution(bind, TheiaSendBdFileUpdates);
    bind(FrontendApplicationContribution).toService(TheiaSendBdFileUpdates);
    bind(CommandContribution).to(TheiaExampleCommandContribution);
    bind(TheiaExampleCommandContribution).toSelf();
    // bind(SharedStringClientImpl).toSelf().inSingletonScope();
    bind(GettingStartedWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GettingStartedWidget.ID,
        createWidget: () => context.container.get<GettingStartedWidget>(GettingStartedWidget),
    })).inSingletonScope();

    bind(ItoiServer).toDynamicValue(ctx => {
        const connection = ctx.container.get(WebSocketConnectionProvider);
        return connection.createProxy<ItoiServer>(
          "/services/itoi",
          ItoiClientNode
        );
      });
});





