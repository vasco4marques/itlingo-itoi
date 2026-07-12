import { ContainerModule } from 'inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { DslRuntimeConfigContribution } from './dsl-runtime-backend-contribution';

export default new ContainerModule(bind => {
    bind(BackendApplicationContribution).to(DslRuntimeConfigContribution).inSingletonScope();
});
