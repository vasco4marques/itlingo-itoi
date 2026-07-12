import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { DslRuntimeFrontendContribution } from './dsl-runtime-contribution';

export default new ContainerModule(bind => {
    bind(DslRuntimeFrontendContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DslRuntimeFrontendContribution);
});
