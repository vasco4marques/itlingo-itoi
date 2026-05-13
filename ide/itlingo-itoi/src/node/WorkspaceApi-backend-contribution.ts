import { injectable } from 'inversify';
import * as express from 'express';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import axios from 'axios';
//const pg = require('pg');
import * as fs from 'fs';
import * as nsfw from 'nsfw'
import * as cp from 'child_process'
import path = require("path");
import * as uuid from 'uuid';
import * as session from 'express-session';
import { Pool, QueryResult }  from 'pg';
import { createLogger, redactDbUrl } from './logger';
const getDirName = require('path').dirname
const crypto = require('crypto');

const dbLog = createLogger('db');
const httpLog = createLogger('http');
const workspaceLog = createLogger('workspace');
const watcherLog = createLogger('watcher');
const cloudLog = createLogger('itlingo-cloud');
const gitLog = createLogger('git');

const hostfs = process.env.HOST_FS || "/tmp/theia/workspaces/";
export const hostroot = process.env.HOST_ROOT || "/home/theia/ide/";
const staticFolderLength = 63;
const COM_KEY = process.env.COM_KEY || "v8y/B?E(H+MbQeThWmZq4t7w!z$C&F)J";
const COOKIE_KEY = process.env.COOKIE_KEY || "0JWVNoq6y7X8hai2r59YY8ILAxC8wcvGODtGvEkv2yKgxlVPfpCeUGqHsoxObdXV";
const itlingoCloudURL = process.env.ITLINGO_CLOUD_URL || "http://localhost:8069/";
export const hostname = new URL(itlingoCloudURL).hostname;
const workspaces: Map<string, string[]> = new Map<string, string[]>();

type Editor = {
    workspace: string;
    foldername:string;
    write: boolean;
    time:number;
    workspaceid: number;
};

declare module "express-session" {
    interface SessionData {
      workspace: Editor;
      tokens: {
        iv: String,
        t: String
      }
    }
  }

@injectable()
export class SwitchWSBackendContribution implements BackendApplicationContribution {

    initialize() {
        // setInterval(() => {
        //   this.sharedStringServer.greet("Hello from backend module");
        // }, 1000);
    }

    configure(app: express.Application) {
        //setup DB
        const connectionString = process.env.DATABASE_URL;
        const isDev = process.env.ITOI_PROD === "DEV";
        dbLog.info("configuring pg pool", {
            url: redactDbUrl(connectionString),
            ssl: !isDev,
            mode: isDev ? "DEV" : "PROD",
        });
        let pgPoolOptions:Object = {connectionString,
            ssl: {
                rejectUnauthorized: false
            }
        };
        if (isDev){
            pgPoolOptions = {connectionString,
                ssl: false
            };
        }

        const pgPool = new Pool(pgPoolOptions);
        pgPool.on('connect', () => dbLog.debug("pg client connected"));
        pgPool.on('acquire', () => dbLog.trace("pg client acquired"));
        pgPool.on('remove', () => dbLog.debug("pg client removed"));
        pgPool.on('error', (err) => dbLog.error("pg pool error", { err: err.message, stack: err.stack }));

        function fetchParamsFromEvent(event: nsfw.FileChangeEvent): string[] | undefined {
            const splitPaths = event.directory.split(path.sep);
            const candidate = splitPaths[6];
            if (!candidate) return undefined;
            return workspaces.get(candidate);
        }
        
        async function pullFilesFromDb(destinationFolder: string, params: string[]) {
            const workspace = params[0];
            const username = params[1];
            const write = params[3];
            workspaceLog.info("pulling files from storage", {
                workspace,
                username,
                write,
                destinationFolder,
            });
            const selectQuery = "SELECT filename, file FROM public.fn_pullfiles($1::varchar);";
            const client = await pgPool.connect();
            client.query(selectQuery, [workspace], async (err:Error, res:any) => {
                if(err) {
                    dbLog.error("fn_pullfiles failed", { workspace, err: err.message, stack: err.stack });
                    client.release();
                    return;
                }
                dbLog.info("fn_pullfiles returned rows", { workspace, count: res.rows.length });
                res.rows.forEach((element:any) => {
                    fs.mkdirSync(getDirName(destinationFolder + '/' + element.filename), {recursive: true});
                    fs.writeFileSync(destinationFolder + '/' + element.filename, element.file);
                });
                workspaceLog.info("wrote pulled files to disk", { workspace, count: res.rows.length, destinationFolder });
                client.release();

                const clientGit = await pgPool.connect();
                const gitQuery = "SELECT repo FROM fn_getgitrepo($1::varchar);";
                clientGit.query(gitQuery, [workspace], (gitErr:Error, result:QueryResult)=>{
                    if (gitErr) {
                        dbLog.error("fn_getgitrepo failed", { workspace, err: gitErr.message });
                        clientGit.release();
                        return;
                    }
                    if (result.rows.length > 0){
                        const repo = result.rows[0].repo;
                        gitLog.info("cloning git repo on workspace pull", { workspace, username, destinationFolder });
                        try {
                            let scriptPath = path.join(hostroot, "gitUtils", "cloneScript.sh");
                            cp.execSync(`${scriptPath} ${destinationFolder} ${username} ${repo}`);
                            gitLog.info("git clone finished", { workspace });
                        } catch (e:any) {
                            gitLog.error("git clone failed", { workspace, err: e?.message });
                        }
                    } else {
                        gitLog.debug("no git repo associated to workspace", { workspace });
                    }
                    clientGit.release();
                });
            });


        }


        async function addFileToDB( event:nsfw.CreatedFileEvent){
            const params = fetchParamsFromEvent(event);
            if (!params) {
                watcherLog.trace("ignoring create event outside any workspace", { directory: event.directory, file: event.file });
                return;
            }
            const workspace = params[0];
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + workspace.length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            if (fs.lstatSync(fullfilepath).isDirectory()) {
                watcherLog.debug("ignoring created directory", { workspace, dir: onlyFile });
                return;
            }
            if (onlyFile.substring(0,4)==='.git') {
                watcherLog.debug("ignoring .git path on create", { workspace, file: onlyFile });
                return;
            }
            dbLog.info("sp_insertfiles begin", { workspace, file: onlyFile });
            const client = await pgPool.connect();
            let rawData = fs.readFileSync(fullfilepath);
            client.query("CALL public.sp_insertfiles($1::varchar,$2::varchar,$3::bytea);", [onlyFile,workspace, rawData], (err:any, _res:any) =>
            {
                if(err) {
                    dbLog.error("sp_insertfiles failed", { workspace, file: onlyFile, err: err.message, stack: err.stack });
                    return;
                }
                dbLog.info("sp_insertfiles ok", { workspace, file: onlyFile, bytes: rawData.length });
            });
            client.release();
        }


       async function changeFileToDB( event: nsfw.ModifiedFileEvent) {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                watcherLog.trace("ignoring modify event outside any workspace", { directory: event.directory, file: event.file });
                return;
            }
            const workspace = params[0];
            const client = await pgPool.connect();
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + workspace.length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            try {
                if (onlyFile.substring(0,4)==='.git') {
                    watcherLog.debug("ignoring .git path on modify", { workspace, file: onlyFile });
                    return;
                }
                var rawData = fs.readFileSync(fullfilepath);
                dbLog.info("sp_changefile begin", { workspace, file: onlyFile, bytes: rawData.length });
                await client.query("BEGIN");
                const insertQuery = "CALL public.sp_changefile($1::varchar, $2::varchar, $3::bytea);"
                client.query(insertQuery, [onlyFile,workspace, rawData]);
                await client.query("COMMIT");
                dbLog.info("sp_changefile committed", { workspace, file: onlyFile });
            } catch (e:any) {
                dbLog.error("sp_changefile failed, rolling back", { workspace, file: onlyFile, err: e?.message });
                await client.query("ROLLBACK");
            } finally {
                client.release();
            }
        }

        function deleteFileToDB( event: nsfw.DeletedFileEvent) {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                watcherLog.trace("ignoring delete event outside any workspace", { directory: event.directory, file: event.file });
                return;
            }
            const workspace = params[0];
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + workspace.length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            dbLog.info("sp_deleteFile begin", { workspace, file: onlyFile });
            const deleteQuery = "CALL public.sp_deleteFile($1::varchar, $2::varchar);";
            pgPool.query(deleteQuery,[onlyFile + '%', workspace], (err:any) => {
                if (err) {
                    dbLog.error("sp_deleteFile failed", { workspace, file: onlyFile, err: err.message });
                    return;
                }
                dbLog.info("sp_deleteFile ok", { workspace, file: onlyFile });
            });
        }

        function renameFileToDB( event: nsfw.RenamedFileEvent) {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                watcherLog.trace("ignoring rename event outside any workspace", { directory: event.directory, file: event.oldFile });
                return;
            }
            const workspace = params[0];
            const fullfilepath = event.directory + '/' + event.oldFile;
            const newfullfilepath = event.newDirectory + '/' + event.newFile;
            const removeNameLength = staticFolderLength + workspace.length + 1;
            const oldFile = fullfilepath.substring(removeNameLength);
            const newFile = newfullfilepath.substring(removeNameLength);
            dbLog.info("sp_updatefilename begin", { workspace, oldFile, newFile });
            const updateQuery = "CALL public.sp_updatefilename($1::varchar,$2::varchar,$3::varchar);";
            pgPool.query(updateQuery, [oldFile,newFile, workspace], (err:any) => {
                if (err) {
                    dbLog.error("sp_updatefilename failed", { workspace, oldFile, newFile, err: err.message });
                    return;
                }
                dbLog.info("sp_updatefilename ok", { workspace, oldFile, newFile });
            });
        }

        function decrypt(iv: string, t: string): string[] {
            iv = iv.replace(/\-/g, '+').replace(/_/g, '/');
            t = t.replace(/\-/g, '+').replace(/_/g, '/');

            const initialVector = Buffer.from(iv, 'base64');
            const token = Buffer.from(t, 'base64').toString('hex');
            const key = Buffer.from(COM_KEY,'utf8');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, initialVector);
            decipher.setAutoPadding(false);
            const deciphered = decipher.update(token, 'hex', 'utf-8') + decipher.final('utf-8');
            let result = JSON.parse(deciphered.substr(0, deciphered.search('}')+1));
            return [result['workspace'], result['user'], result['organization'],result['write']?"true":"false",result['wsid']]
        }
        
        cp.execSync("mkdir -p " + hostfs + "tmp/");
        app.use(session({ secret: COOKIE_KEY, cookie: { maxAge: 60000 }}));

        // request access logging (status + duration)
        app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const durationMs = Date.now() - start;
                const sessionId = (req as any).sessionID
                    ? crypto.createHash('sha1').update((req as any).sessionID).digest('hex').slice(0, 8)
                    : undefined;
                httpLog.info("request", {
                    method: req.method,
                    path: req.path,
                    status: res.statusCode,
                    durationMs,
                    sessionId,
                });
            });
            next();
        });

        createWatcher(hostfs + 'tmp/')
        // registerCollab(app);
        app.get('/getWorkspace', (req, res) => {
            if(!req.session.workspace || !req.session.tokens){
                httpLog.warn("getWorkspace called without session", { hasWorkspace: !!req.session.workspace, hasTokens: !!req.session.tokens });
                res.statusCode = 401;
                res.end();
                return
            }
            let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
            let username: string = "";
            let params = workspaces.get(workspaceName);
            if(params){
                username=params[1];
            }
            httpLog.info("getWorkspace ok", {
                workspace: workspaceName,
                username,
                readonly: !req.session.workspace.write,
            });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json({
                foldername: req.session.workspace.foldername,  
                readonly: !req.session.workspace.write,
                tokens: {
                    iv: req.session.tokens.iv,
                    t: req.session.tokens.t
                },
                username: username
            });
            res.end();
        });

        app.get('/createTempWorkspace', (req, res) => {
            if(req.query.iv == undefined || req.query.t == undefined) {
                httpLog.warn("createTempWorkspace missing iv/t, redirecting to itlingo cloud");
                res.statusCode = 301;
                res.redirect(itlingoCloudURL);
                res.end();
            } else {
                let iv = req.query.iv as string;
                let token = req.query.t as string;
                req.session.tokens = {
                    iv: iv,
                    t: token
                };
                let params;
                try {
                    params = decrypt(iv, token);
                } catch (e:any) {
                    httpLog.error("createTempWorkspace decrypt failed", { err: e?.message });
                    res.statusCode = 400;
                    res.end();
                    return;
                }
                httpLog.info("createTempWorkspace decrypted token", {
                    workspace: params[0],
                    username: params[1],
                    organization: params[2],
                    write: params[3],
                    wsid: params[4],
                });
                createWorkspace(req, params);
                req.session.save();
                res.statusCode = 301;
                res.redirect('/');
                res.end();
            }
        });

        // app.get('/ping', (req, res) => {
        //     if(req.session.workspace) {
        //         req.session.workspace.time =  Date.now();
        //         if(!workspaces.has(req.session.workspace.workspace)){
        //             res.statusCode = 500;
        //             res.setHeader('Content-Type', 'text/plain');
        //             res.end();
        //         } else {
        //             res.statusCode = 200;
        //             res.setHeader('Content-Type', 'text/plain');
        //             res.end();
        //         };
        //     } else {
        //         res.statusCode = 500;
        //         res.setHeader('Content-Type', 'text/plain');
        //         res.end();
        //     }
            
        // });

        app.get('/reconnect', (req, res) => {
                httpLog.info("reconnect requested");
                res.statusCode = 301;
                res.redirect('/createTempWorkspace?iv=' + req.query.iv + '&t=' + req.query.t);
                res.end();
        });


        app.get('/setupRSL', (req, res) => {
            if(req.session.workspace) {
                httpLog.info("setupRSL", { foldername: req.session.workspace.foldername });
                copyRSLFolder(req.session.workspace.foldername)
            } else {
                httpLog.warn("setupRSL without session");
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });

        app.get('/setupASL', (req, res) => {
            if(req.session.workspace) {
                httpLog.info("setupASL", { foldername: req.session.workspace.foldername });
                copyASLFolder(req.session.workspace.foldername)
            } else {
                httpLog.warn("setupASL without session");
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });


        app.get('/setupCustom',async (req, res) => {
            let responseItlingoCloud;
            if(req.session.workspace) {
                responseItlingoCloud = await setupCustomFiles(req.session.workspace);
            } else {
                httpLog.warn("setupCustom without session");
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json(responseItlingoCloud?.data);
            res.end();
        });

        app.get('/setupCustomAccepted',async (req, res) => {
            if(req.session.workspace) {
                cloudLog.info("setupCustomAccepted", {
                    workspaceid: req.session.workspace.workspaceid,
                    filename: req.query.filename,
                    fileid: req.query.fileid,
                });
                downloadItlingoFiles(req.session.workspace, req.query.filename as string, req.query.fileid as string);
            } else {
                httpLog.warn("setupCustomAccepted without session");
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });


        app.get('/cloneRepo', async (req, res) => {
            if(req.session.workspace) {
                let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
                let jsonData = JSON.parse(Buffer.from(req.query.data as string, "base64").toString());
                gitLog.info("cloneRepo", { workspace: workspaceName, username: jsonData.username, repository: jsonData.repository });
                try {
                    let scriptPath = path.join(hostroot, "gitUtils", "cloneScript.sh");
                    cp.execSync(`${scriptPath} ${req.session.workspace.foldername} ${jsonData.username} ${jsonData.repository}`);
                    gitLog.info("cloneRepo script ok", { workspace: workspaceName });
                } catch (e:any) {
                    gitLog.error("cloneRepo script failed", { workspace: workspaceName, err: e?.message });
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end();
                    return;
                }
                let query = 'CALL public.sp_assignGit($1::varchar, $2::varchar)';
                dbLog.info("sp_assignGit begin", { workspace: workspaceName, repo: jsonData.repository });
                pgPool.query(query, [workspaceName,jsonData.repository] , (err:any, _qres:any) =>
                {
                    if(err) {
                        dbLog.error("sp_assignGit failed", { workspace: workspaceName, err: err.message, stack: err.stack });
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end();
                        return;
                    }
                    dbLog.info("sp_assignGit ok", { workspace: workspaceName });
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end();
                });
            } else {
                httpLog.warn("cloneRepo without session");
                res.statusCode = 401;
                res.end();
            }

        });


        app.get('/gitCheckout', (req, res) => {
            if(req.session.workspace) {
                gitLog.info("checkout", { foldername: req.session.workspace.foldername, target: req.query.data });
                try {
                    let output = cp.execSync(`cd ${req.session.workspace.foldername} && git checkout ${req.query.data}`).toString();
                    if(output === '') output = "Sucess!"
                    gitLog.info("checkout ok", { foldername: req.session.workspace.foldername });
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.json({
                        output: output
                    })
                    res.end();
                } catch (e:any) {
                    gitLog.error("checkout failed", { foldername: req.session.workspace.foldername, err: e?.message });
                    res.statusCode = 500;
                    res.end();
                }
            }
        });

        app.get('/gitBranch', (req, res) => {
            if(req.session.workspace) {
                gitLog.info("branch", { foldername: req.session.workspace.foldername, branch: req.query.data });
                try {
                    let output = cp.execSync(`cd ${req.session.workspace.foldername} && git checkout -b ${req.query.data}`).toString();
                    if(output === '') output = "Sucess!"
                    gitLog.info("branch ok", { foldername: req.session.workspace.foldername });
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.json({
                        output: output
                    })
                    res.end();
                } catch (e:any) {
                    gitLog.error("branch failed", { foldername: req.session.workspace.foldername, err: e?.message });
                    res.statusCode = 500;
                    res.end();
                }
            }
        });


        app.get('/gitPull', (req, res) => {
            if(req.session.workspace) {
                let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
                gitLog.info("pull requested", { workspace: workspaceName });
                pgPool.query('SELECT repo FROM public.fn_getgitrepo($1::varchar)', [workspaceName], (err:any, qres:QueryResult) => {
                    if(err){
                        dbLog.error("fn_getgitrepo failed", { workspace: workspaceName, err: err.message });
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end();
                        return;
                    }
                    if(!req.session.workspace) return;
                    try {
                        let output = cp.execSync(`cd ${req.session.workspace.foldername} && git pull ${qres.rows[0].repo}`).toString();
                        if(output === '') output = "Sucess!"
                        gitLog.info("pull ok", { workspace: workspaceName });
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'text/plain');
                        res.json({
                            output: output
                        })
                        res.end();
                    } catch (e:any) {
                        gitLog.error("pull failed", { workspace: workspaceName, err: e?.message });
                        res.statusCode = 500;
                        res.end();
                    }
                });
            }

        });

        app.get('/gitPush',(req, res) => {

            if(req.session.workspace) {
                let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
                gitLog.info("push requested", { workspace: workspaceName });
                pgPool.query('SELECT repo FROM public.fn_getgitrepo($1::varchar)', [workspaceName], (err:any, qres:any) => {
                    if(err){
                        dbLog.error("fn_getgitrepo failed", { workspace: workspaceName, err: err.message });
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end();
                        return;
                    }
                    if(!req.session.workspace) return;
                    try {
                        let output = cp.execSync(`cd ${req.session.workspace.foldername} && git push ${qres.rows[0].repo}`).toString();
                        if(output === '') output = "Sucess!"
                        gitLog.info("push ok", { workspace: workspaceName });
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'text/plain');
                        res.json({
                            output: output
                        })
                        res.end();
                    } catch (e:any) {
                        gitLog.error("push failed", { workspace: workspaceName, err: e?.message });
                        res.statusCode = 500;
                        res.end();
                    }
                });
            }

        });
    



        async function setupCustomFiles(editor:Editor){
            const requestPath = 'token_api/get-file-list/' + editor.workspaceid;
            cloudLog.info("get-file-list", { workspaceid: editor.workspaceid, path: requestPath });
            try {
                const result = await axios.get<JSON>(itlingoCloudURL + requestPath);
                cloudLog.info("get-file-list ok", { workspaceid: editor.workspaceid, status: result.status });
                return result;
            } catch (e:any) {
                cloudLog.error("get-file-list failed", { workspaceid: editor.workspaceid, err: e?.message });
                throw e;
            }
        }

        async function downloadItlingoFiles(editor:Editor, filename:string,fileId:string){
            const downloadPath = 'token_api/download-file/' + editor.workspaceid + '/' + fileId;
            cloudLog.info("download-file begin", { workspaceid: editor.workspaceid, fileId, filename });
            axios({
                url: itlingoCloudURL + downloadPath,
                method: 'GET',
                responseType: 'blob',
            }).then((response) => {
                let filenameToWrite = editor.foldername + '/' + filename;
                fs.writeFileSync(filenameToWrite, response.data);
                cloudLog.info("download-file written to disk", { workspaceid: editor.workspaceid, fileId, filenameToWrite });
            }).catch((e:any) => {
                cloudLog.error("download-file failed", { workspaceid: editor.workspaceid, fileId, err: e?.message });
            });
        }

        function copyASLFolder(path:string){
            copyFolder('ASL', path);
        }
        function copyRSLFolder(path:string){
            copyFolder('RSL', path);
        }

        function copyFolder(arg: string, path:string){
            switch (arg) {
                case 'ASL':
                    fs.cpSync(hostroot + 'templates/ASL/', path, { recursive: true });
                    break;
                case 'RSL':
                    fs.cpSync(hostroot + 'templates/RSL/', path, { recursive: true });
                    break;
            
                default:
                    break;
            }
        }

function createWorkspace(req:Express.Request, params:string[]){
    const workspace = params[0];
    const username = params[1];
    const write = params[3]=="true";
    const workspaceid = Number.parseInt(params[4]);

    if (workspaceExists(workspace)){
        let savedParams = workspaces.get(workspace) as string[];
        workspaceLog.info("reusing existing workspace", {
            workspace,
            username,
            workspaceid,
            write,
            foldername: savedParams[5],
        });
        req.session.workspace = {
            workspace,
            foldername: savedParams[5],
            write,
            time: Date.now(),
            workspaceid,
        };
        return;
    }
    let wuuid = uuid.v4();
    var randomFoldername = hostfs + 'tmp/' + wuuid + '/'+ workspace;
    workspaceLog.info("creating new workspace", {
        workspace,
        username,
        workspaceid,
        write,
        uuid: wuuid,
        foldername: randomFoldername,
    });
    req.session.workspace = {
        workspace,
        foldername: randomFoldername,
        write,
        time: Date.now(),
        workspaceid,
     };
     fs.mkdir(randomFoldername, {recursive: true},(err:any) => {
         if (err) {
             workspaceLog.error("mkdir for new workspace failed", { workspace, foldername: randomFoldername, err: err.message });
             throw err;
         }
         workspaceLog.debug("workspace folder created", { workspace, foldername: randomFoldername });
     });
    params.push(randomFoldername);
    workspaces.set(workspace, params);
    pullFilesFromDb(randomFoldername,params);
}

function workspaceExists(workspace: string){
    for(const key of workspaces.keys()){
        if(key === workspace) return true;
    }
    return false;
}


    async function  createWatcher(watchPath:string){
        let watcher: nsfw.NSFW | undefined = await nsfw(fs.realpathSync(watchPath), (events: nsfw.FileChangeEvent[]) => {
            for (const event of events) {
                if (event.action === nsfw.actions.CREATED) {
                    watcherLog.debug("file created", { directory: event.directory, file: event.file });
                    addFileToDB( event);
                }
                if (event.action === nsfw.actions.DELETED) {
                    watcherLog.debug("file deleted", { directory: event.directory, file: event.file });
                    deleteFileToDB( event);
                }
                if (event.action === nsfw.actions.MODIFIED) {
                    watcherLog.debug("file modified", { directory: event.directory, file: event.file });
                    changeFileToDB( event);
                }
                if (event.action === nsfw.actions.RENAMED) {
                    watcherLog.debug("file renamed", {
                        from: event.directory + '/' + event.oldFile,
                        to: event.newDirectory + '/' + event.newFile,
                    });
                    renameFileToDB( event);
                }
            }
        }, {
                errorCallback: error => {
                    watcherLog.warn("watch error", { path: watchPath, err: String(error) });
                }
            });
        watcherLog.info("watcher created", { path: watchPath });
        await watcher.start();
        return watcher;
    }

    }
}

function getWorkspaceFromPath(foldername: string) : string{
    let arr = foldername.split('/');
    return arr[arr.length-1];
}

