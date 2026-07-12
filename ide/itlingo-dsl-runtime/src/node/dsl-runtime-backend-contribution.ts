import { injectable } from 'inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { Application } from '@theia/core/shared/express';

/**
 * Serves the frontend the public URL of the external dsl-lsp-service.
 * Kept in this extension so `itlingo-itoi` stays untouched.
 */
@injectable()
export class DslRuntimeConfigContribution implements BackendApplicationContribution {

    configure(app: Application): void {
        app.get('/dslservice/config', (_req, res) => {
            res.json({
                url: process.env.DSL_LSP_PUBLIC_URL || 'http://localhost:3001',
            });
        });
    }
}
