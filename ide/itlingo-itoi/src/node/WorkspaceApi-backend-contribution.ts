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
import connectPgSimple = require('connect-pg-simple');
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
const initialPullPaths: Set<string> = new Set<string>();
// Resolved target paths reserved by in-flight imports so that concurrent
// downloads of same-named files in one batch don't pick the same dedup name.
const reservedImportPaths: Set<string> = new Set<string>();
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

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
                    const fullPath = destinationFolder + '/' + element.filename;
                    // Mark this path so the nsfw watcher does NOT echo the
                    // upcoming CREATED/MODIFIED events back to the DB.
                    initialPullPaths.add(fullPath);
                    setTimeout(() => initialPullPaths.delete(fullPath), 5000);
                    fs.mkdirSync(getDirName(fullPath), {recursive: true});
                    fs.writeFileSync(fullPath, element.file);
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
            if (initialPullPaths.has(fullfilepath)) {
                watcherLog.debug("ignoring create event from initial pull", { workspace, file: onlyFile });
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
                if (initialPullPaths.has(fullfilepath)) {
                    watcherLog.debug("ignoring modify event from initial pull", { workspace, file: onlyFile });
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

        app.set('trust proxy', 1);

        const PgSession = connectPgSimple(session);
        const cookieSecure = process.env.ITOI_PROD === "DEV" ? false : true;
        app.use(session({
            store: new PgSession({
                pool: pgPool,
                tableName: 'user_sessions',
                createTableIfMissing: true,
            }),
            secret: COOKIE_KEY,
            resave: false,
            saveUninitialized: false,
            rolling: false,
            proxy: true,
            cookie: {
                maxAge: SESSION_MAX_AGE_MS,
                httpOnly: true,
                sameSite: 'lax',
                secure: cookieSecure,
            },
        }));

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
            if(req.session.workspace && req.session.tokens) {
                if(!req.session.workspace.write) {
                    httpLog.warn("setupCustom denied for read-only user", { workspaceid: req.session.workspace.workspaceid });
                    res.statusCode = 403;
                    res.setHeader('Content-Type', 'json/application');
                    res.json({ error: 'Importing itlingo cloud documents requires write access.' });
                    res.end();
                    return;
                }
                responseItlingoCloud = await setupCustomFiles(req.session.workspace, req.session.tokens);
            } else {
                httpLog.warn("setupCustom without session", { hasWorkspace: !!req.session.workspace, hasTokens: !!req.session.tokens });
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json(responseItlingoCloud?.data);
            res.end();
        });

        app.get('/setupCustomAccepted',async (req, res) => {
            if(req.session.workspace && req.session.tokens) {
                if(!req.session.workspace.write) {
                    httpLog.warn("setupCustomAccepted denied for read-only user", {
                        workspaceid: req.session.workspace.workspaceid,
                        fileid: req.query.fileid,
                    });
                    res.statusCode = 403;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end();
                    return;
                }
                cloudLog.info("setupCustomAccepted", {
                    workspaceid: req.session.workspace.workspaceid,
                    filename: req.query.filename,
                    fileid: req.query.fileid,
                });
                await downloadItlingoFiles(req.session.workspace, req.session.tokens, req.query.filename as string, req.query.fileid as string);
            } else {
                httpLog.warn("setupCustomAccepted without session", { hasWorkspace: !!req.session.workspace, hasTokens: !!req.session.tokens });
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
    



        function dedupFilename(filename: string, existingNames: Set<string>): string {
            const existingLower = new Set(Array.from(existingNames).map(n => n.toLowerCase()));
            if (!existingLower.has(filename.toLowerCase())) return filename;
            const dotIdx = filename.lastIndexOf('.');
            const base = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
            const suffix = dotIdx > 0 ? filename.substring(dotIdx) : '';
            let n = 1;
            while (existingLower.has(`${base}(${n})${suffix}`.toLowerCase())) n++;
            return `${base}(${n})${suffix}`;
        }

        async function fetchDbFilenames(workspaceName: string): Promise<Set<string>> {
            const result = await pgPool.query(
                'SELECT f.filename FROM t_files f JOIN t_workspaces w ON f.workspace_id = w.id WHERE w.workspace = $1;',
                [workspaceName],
            );
            return new Set<string>(result.rows.map((r: any) => String(r.filename)));
        }

        // Push a file into a workspace (from ITLingo Cloud, e.g. chatbot exports).
        // If the workspace is open, the file is written into the live folder AND
        // persisted to the DB synchronously (the watcher echo is suppressed), so
        // any failure is reported in the response. If the workspace is closed,
        // the file is inserted into the DB and delivered on the next open.
        // Error responses carry a machine-readable `code` so the cloud can
        // propagate precise failure reasons back to the chatbot.
        app.post('/pushFile', express.json({ limit: '2mb' }), async (req, res) => {
            const fail = (status: number, code: string, message: string) => {
                res.status(status).json({ code, error: message });
            };

            const authHeader = (req.headers['authorization'] as string) || '';
            if (!authHeader.startsWith('Bearer ')) {
                fail(401, 'auth_missing', 'Missing or invalid Authorization header');
                return;
            }
            const tokenParts = authHeader.substring(7).split(':');
            if (tokenParts.length !== 2) {
                fail(401, 'auth_invalid', 'Token must be iv:ciphertext');
                return;
            }
            let params: string[];
            try {
                params = decrypt(tokenParts[0], tokenParts[1]);
            } catch (e: any) {
                cloudLog.warn("pushFile token decrypt failed", { err: e?.message });
                fail(401, 'auth_invalid', 'Invalid token');
                return;
            }
            const workspaceName = params[0];
            const write = params[3] === 'true';
            const wsid = String(params[4]);
            if (!write) {
                fail(403, 'write_denied', 'Token does not grant write access');
                return;
            }

            const rawFilename = (req.body && req.body.filename) ? String(req.body.filename) : '';
            const filename = path.basename(rawFilename);
            if (!filename || filename === '.' || filename === '..') {
                fail(400, 'invalid_filename', 'Missing or invalid filename');
                return;
            }
            const contentB64 = (req.body && req.body.content) ? String(req.body.content) : '';
            if (!contentB64) {
                fail(400, 'invalid_content', 'Missing content');
                return;
            }
            let content: Buffer;
            try {
                content = Buffer.from(contentB64, 'base64');
            } catch {
                fail(400, 'invalid_content', 'Content must be base64');
                return;
            }

            const savedParams = workspaces.get(workspaceName);
            if (savedParams && String(savedParams[4]) !== wsid) {
                cloudLog.warn("pushFile wsid mismatch", { workspace: workspaceName, wsid, saved: savedParams[4] });
                fail(403, 'workspace_mismatch', 'Workspace mismatch');
                return;
            }

            if (savedParams) {
                // Live session: write into the workspace folder and persist to
                // the DB ourselves so failures surface in this response.
                const folder = savedParams[5];
                let existing: Set<string>;
                try {
                    existing = new Set(fs.readdirSync(folder));
                } catch (e: any) {
                    cloudLog.error("pushFile readdir failed", { workspace: workspaceName, err: e?.message });
                    fail(500, 'folder_unavailable', 'Workspace folder unavailable');
                    return;
                }
                // Dedup against folder AND DB so neither write can collide.
                try {
                    for (const name of await fetchDbFilenames(workspaceName)) existing.add(name);
                } catch (e: any) {
                    dbLog.error("pushFile DB filename lookup failed", { workspace: workspaceName, err: e?.message });
                    fail(500, 'db_error', `Could not read workspace files: ${e?.message || 'unknown error'}`);
                    return;
                }
                const finalName = dedupFilename(filename, existing);
                const resolvedRoot = path.resolve(folder);
                const resolvedTarget = path.resolve(path.join(folder, finalName));
                if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
                    cloudLog.error("pushFile rejected unsafe filename", { workspace: workspaceName, filename });
                    fail(400, 'invalid_filename', 'Invalid filename');
                    return;
                }
                // Suppress the watcher echo for this write: we persist to the
                // DB synchronously below (same mechanism as pullFilesFromDb).
                const watcherKey = folder + '/' + finalName;
                initialPullPaths.add(watcherKey);
                initialPullPaths.add(resolvedTarget);
                setTimeout(() => { initialPullPaths.delete(watcherKey); initialPullPaths.delete(resolvedTarget); }, 5000);
                try {
                    fs.writeFileSync(resolvedTarget, content);
                } catch (e: any) {
                    cloudLog.error("pushFile write failed", { workspace: workspaceName, file: finalName, err: e?.message });
                    fail(500, 'write_failed', `Failed to write file: ${e?.message || 'unknown error'}`);
                    return;
                }
                try {
                    // sp_changefile is delete+insert (upsert), so it cannot
                    // hit the t_files primary-key violation sp_insertfiles can.
                    await pgPool.query(
                        'CALL public.sp_changefile($1::varchar,$2::varchar,$3::bytea);',
                        [finalName, workspaceName, content],
                    );
                } catch (e: any) {
                    dbLog.error("pushFile DB persist failed", { workspace: workspaceName, file: finalName, err: e?.message });
                    // Keep folder and DB consistent: remove the file we just
                    // wrote, otherwise it would vanish on the next workspace open.
                    try { fs.unlinkSync(resolvedTarget); } catch { /* best effort */ }
                    fail(500, 'db_write_failed', `File could not be persisted: ${e?.message || 'unknown error'}`);
                    return;
                }
                cloudLog.info("pushFile written to live workspace and DB", { workspace: workspaceName, file: finalName });
                res.status(200).json({ pushed: true, live: true, file_name: finalName });
                return;
            }

            // No live session: insert directly into the DB so the file is
            // delivered on the next workspace open (fn_pullfiles).
            const client = await pgPool.connect();
            try {
                // sp_insertfiles does not create the workspace row; ensure it exists.
                await client.query(
                    'INSERT INTO t_workspaces (workspace) VALUES ($1) ON CONFLICT (workspace) DO NOTHING;',
                    [workspaceName],
                );
                const existingRes = await client.query(
                    'SELECT f.filename FROM t_files f JOIN t_workspaces w ON f.workspace_id = w.id WHERE w.workspace = $1;',
                    [workspaceName],
                );
                const existing = new Set<string>(existingRes.rows.map((r: any) => String(r.filename)));
                const finalName = dedupFilename(filename, existing);
                await client.query(
                    'CALL public.sp_insertfiles($1::varchar,$2::varchar,$3::bytea);',
                    [finalName, workspaceName, content],
                );
                cloudLog.info("pushFile inserted into DB (workspace closed)", { workspace: workspaceName, file: finalName });
                res.status(200).json({ pushed: true, live: false, file_name: finalName });
            } catch (e: any) {
                dbLog.error("pushFile DB insert failed", { workspace: workspaceName, file: filename, err: e?.message });
                fail(500, 'db_write_failed', `File could not be stored: ${e?.message || 'unknown error'}`);
            } finally {
                client.release();
            }
        });

        function buildCloudAuthHeader(tokens: { iv: String, t: String }): string {
            return 'Bearer ' + tokens.iv + ':' + tokens.t;
        }

        async function setupCustomFiles(editor:Editor, tokens: { iv: String, t: String }){
            const requestPath = 'token_api/get-file-list/' + editor.workspaceid;
            cloudLog.info("get-file-list", { workspaceid: editor.workspaceid, path: requestPath });
            try {
                const result = await axios.get<JSON>(itlingoCloudURL + requestPath, {
                    headers: { Authorization: buildCloudAuthHeader(tokens) },
                });
                cloudLog.info("get-file-list ok", { workspaceid: editor.workspaceid, status: result.status });
                return result;
            } catch (e:any) {
                cloudLog.error("get-file-list failed", { workspaceid: editor.workspaceid, err: e?.message });
                throw e;
            }
        }

        async function downloadItlingoFiles(editor:Editor, tokens: { iv: String, t: String }, filename:string,fileId:string): Promise<void> {
            const downloadPath = 'token_api/download-file/' + editor.workspaceid + '/' + fileId;
            // Sanitize the filename to its basename and confine the write to the
            // workspace folder to prevent path traversal (e.g. "../../etc/x").
            const safeName = path.basename(filename || '');
            const resolvedRoot = path.resolve(editor.foldername);
            if (!safeName) {
                cloudLog.error("download-file rejected unsafe filename", { workspaceid: editor.workspaceid, fileId, filename });
                return;
            }
            cloudLog.info("download-file begin", { workspaceid: editor.workspaceid, fileId, filename: safeName });
            let response;
            try {
                response = await axios({
                    url: itlingoCloudURL + downloadPath,
                    method: 'GET',
                    responseType: 'arraybuffer',
                    headers: { Authorization: buildCloudAuthHeader(tokens) },
                });
            } catch (e:any) {
                cloudLog.error("download-file failed", { workspaceid: editor.workspaceid, fileId, err: e?.message });
                return;
            }
            // Don't overwrite an existing file: if the name is already taken,
            // import as name(1).ext, name(2).ext, ... The read+dedup+reserve+
            // write below runs synchronously, so concurrent imports in the
            // same batch cannot resolve to the same name.
            let existing: Set<string>;
            try {
                existing = new Set(fs.readdirSync(editor.foldername));
            } catch (e:any) {
                cloudLog.error("download-file readdir failed", { workspaceid: editor.workspaceid, fileId, err: e?.message });
                existing = new Set<string>();
            }
            for (const reserved of reservedImportPaths) {
                if (path.dirname(reserved) === resolvedRoot) {
                    existing.add(path.basename(reserved));
                }
            }
            const finalName = dedupFilename(safeName, existing);
            const resolvedTarget = path.resolve(path.join(editor.foldername, finalName));
            if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
                cloudLog.error("download-file rejected unsafe filename", { workspaceid: editor.workspaceid, fileId, filename });
                return;
            }
            reservedImportPaths.add(resolvedTarget);
            setTimeout(() => reservedImportPaths.delete(resolvedTarget), 5000);
            try {
                fs.writeFileSync(resolvedTarget, Buffer.from(response.data));
            } catch (e:any) {
                cloudLog.error("download-file write failed", { workspaceid: editor.workspaceid, fileId, err: e?.message });
                return;
            }
            cloudLog.info("download-file written to disk", { workspaceid: editor.workspaceid, fileId, filenameToWrite: resolvedTarget, deduped: finalName !== safeName });
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

