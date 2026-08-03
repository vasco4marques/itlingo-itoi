for (const method of ['hasOwnMetadata', 'getMetadata', 'defineMetadata']) {
    if (!Reflect[method]) Reflect[method] = () => undefined;
}

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const actualFs = require('fs');
const comKey = '01234567890123456789012345678901';
process.env.COM_KEY = comKey;

let mkdir = () => Promise.resolve();
const originalLoad = Module._load;
const fakeFs = Object.create(actualFs);
fakeFs.promises = Object.create(actualFs.promises);
fakeFs.promises.mkdir = (...args) => mkdir(...args);
fakeFs.realpathSync = pathname => pathname;

Module._load = function (request, parent, isMain) {
    if (request === 'child_process') return { execSync() {} };
    if (request === 'fs') return fakeFs;
    if (request === 'nsfw') return async () => ({ start: async () => undefined });
    if (request === 'pg') return {
        Pool: class {
            on() { return this; }
            connect() { return new Promise(() => undefined); }
        },
    };
    if (request === 'express') return { json: () => () => undefined };
    if (request === 'express-session') return () => () => undefined;
    if (request === 'connect-pg-simple') return () => class {};
    return originalLoad.call(this, request, parent, isMain);
};

const { SwitchWSBackendContribution } = require('../lib/node/WorkspaceApi-backend-contribution');

function deferred() {
    let resolve;
    let reject;
    return {
        promise: new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        }),
        resolve,
        reject,
    };
}

function queryFor(workspace) {
    const iv = Buffer.alloc(16, 1);
    const payload = JSON.stringify({ workspace, user: 'user', organization: 'organization', write: true, wsid: 1 });
    const padded = payload.padEnd(Math.ceil(payload.length / 16) * 16);
    const cipher = crypto.createCipheriv('aes-256-cbc', comKey, iv);
    cipher.setAutoPadding(false);
    return {
        iv: iv.toString('base64'),
        t: Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64'),
    };
}

function request(events, workspace) {
    let completeSave;
    return {
        query: queryFor(workspace),
        session: {
            save(callback) {
                events.push('save');
                completeSave = callback;
            },
        },
        completeSave(error) {
            completeSave(error);
        },
    };
}

function response(events) {
    return {
        statusCode: 200,
        redirect(location) {
            events.push(`redirect:${location}`);
        },
        end() {
            events.push('end');
        },
    };
}

function tick() {
    return new Promise(resolve => setImmediate(resolve));
}

function createTempWorkspaceRoute() {
    const routes = {};
    const app = {
        set() {},
        use() {},
        get(path, handler) {
            routes[path] = handler;
        },
        post() {},
    };
    new SwitchWSBackendContribution().configure(app);
    Module._load = originalLoad;
    return routes['/createTempWorkspace'];
}

const createTempWorkspace = createTempWorkspaceRoute();

async function newWorkspaceWaitsForDirectoryAndSave() {
    const events = [];
    const directory = deferred();
    const req = request(events, 'new-workspace');
    const res = response(events);
    mkdir = () => {
        events.push('mkdir');
        return directory.promise;
    };

    const launch = createTempWorkspace(req, res);
    await tick();
    assert.deepStrictEqual(events, ['mkdir']);
    directory.resolve();
    await tick();
    assert.deepStrictEqual(events, ['mkdir', 'save']);
    req.completeSave();
    await launch;
    assert.strictEqual(res.statusCode, 301);
    assert.deepStrictEqual(events, ['mkdir', 'save', 'redirect:/', 'end']);
}

async function existingWorkspaceWaitsForSave() {
    const events = [];
    const req = request(events, 'new-workspace');
    const res = response(events);
    mkdir = () => {
        throw new Error('existing workspace must not create a directory');
    };

    const launch = createTempWorkspace(req, res);
    await tick();
    assert.deepStrictEqual(events, ['save']);
    req.completeSave();
    await launch;
    assert.strictEqual(res.statusCode, 301);
    assert.deepStrictEqual(events, ['save', 'redirect:/', 'end']);
}

async function directoryFailureDoesNotRedirect() {
    const events = [];
    const req = request(events, 'broken-directory');
    const res = response(events);
    mkdir = () => {
        events.push('mkdir');
        return Promise.reject(new Error('mkdir failed'));
    };

    await createTempWorkspace(req, res);
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(events, ['mkdir', 'end']);
}

async function saveFailureDoesNotRedirect() {
    const events = [];
    const req = request(events, 'save-failure');
    const res = response(events);
    mkdir = () => {
        events.push('mkdir');
        return Promise.resolve();
    };

    const launch = createTempWorkspace(req, res);
    await tick();
    req.completeSave(new Error('store failed'));
    await launch;
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(events, ['mkdir', 'save', 'end']);
}

(async () => {
    await newWorkspaceWaitsForDirectoryAndSave();
    await existingWorkspaceWaitsForSave();
    await directoryFailureDoesNotRedirect();
    await saveFailureDoesNotRedirect();
    console.log('launch ordering regression checks passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
