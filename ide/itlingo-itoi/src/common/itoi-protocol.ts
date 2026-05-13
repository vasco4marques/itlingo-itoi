import { JsonRpcServer } from '@theia/core';

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
