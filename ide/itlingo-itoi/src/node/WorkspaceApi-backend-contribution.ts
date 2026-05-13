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
const getDirName = require('path').dirname
const crypto = require('crypto');

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
        console.log("CONSTRING - " + connectionString)
        let pgPoolOptions:Object = {connectionString,
            ssl: {
                rejectUnauthorized: false
            }
        };
        if (process.env.ITOI_PROD === "DEV"){
            console.log("DEV");
            pgPoolOptions = {connectionString,
                ssl: false
            };
        }

        const pgPool = new Pool(pgPoolOptions);

        function fetchParamsFromEvent(event: nsfw.FileChangeEvent){
            let splitPaths = event.directory.split(path.sep);
            let params = workspaces.get(splitPaths[6]) as string[];
            return params;
        }
        
        async function pullFilesFromDb(destinationFolder: string, params: string[]) {
            console.log("PullFiles to:");
            console.log(destinationFolder);
            console.log(params[0]);
            console.log("write permissions: " + params[3]);
            const selectQuery = "SELECT filename, file FROM public.fn_pullfiles($1::varchar);";
            const client = await pgPool.connect();
            client.query(selectQuery, [params[0]], async (err:Error, res:any) => {
                if(err) {
                    console.error("PullFiles ERROR");
                    console.error(err.stack);
                    return;
                }
                console.log("SELECT");
                console.log(res); 
                res.rows.forEach((element:any) => {
                    fs.mkdirSync(getDirName(destinationFolder + '/' + element.filename), {recursive: true});
                    fs.writeFileSync(destinationFolder + '/' + element.filename, element.file);
                });
                const clientGit = await pgPool.connect();
                const gitQuery = "SELECT repo FROM fn_getgitrepo($1::varchar);";
                clientGit.query(gitQuery, [params[0]], (err:Error, result:QueryResult)=>{
                    if (result.rows.length >0){
                        let scriptPath = path.join(hostroot, "gitUtils", "cloneScript.sh");
                        cp.execSync(`${scriptPath} ${destinationFolder} ${params[1]} ${result.rows[0].repo}`);
                    }
                });
            });


        }


        async function addFileToDB( event:nsfw.CreatedFileEvent){
            
            console.log("Add file");
            console.log(event.directory);
            console.log(event.file);
            let params = fetchParamsFromEvent(event);
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            console.log("woot: " + onlyFile + " " + onlyFile.substring(0,4));
            if (fs.lstatSync(fullfilepath).isDirectory()) return;
            if (onlyFile.substring(0,4)==='.git') return;
            const client = await pgPool.connect();
            let rawData = fs.readFileSync(fullfilepath);
            await client.query("CALL public.sp_insertfiles($1::varchar,$2::varchar,$3::bytea);", [onlyFile,params[0], rawData], (err:any, res:any) =>
            {
                if(err) {
                    console.error("AddFileToDB ERROR");
                    console.error(err.stack);
                    return;
                }
            });
            client.release();
        }


       async function changeFileToDB( event: nsfw.ModifiedFileEvent) {
            console.log("Change File");
            console.log(event.directory);
            console.log(event.file);
            let params = fetchParamsFromEvent(event);

            const client = await pgPool.connect();
            try {
                const fullfilepath = event.directory + '/' + event.file;
                const removeNameLength = staticFolderLength + params[0].length + 1;
                const onlyFile = fullfilepath.substring(removeNameLength);
                console.log("woot: " + onlyFile + " " + fullfilepath);
                var rawData = fs.readFileSync(fullfilepath);
                if (onlyFile.substring(0,4)==='.git') return;
                await client.query("BEGIN");
                const insertQuery = "CALL public.sp_changefile($1::varchar, $2::varchar, $3::bytea);"
                client.query(insertQuery, [onlyFile,params[0], rawData]);
                await client.query("COMMIT");
            } catch (e) {
                await client.query("ROLLBACK");
            } finally {
                client.release();
            }
        }

        function deleteFileToDB( event: nsfw.DeletedFileEvent) {
            let params = fetchParamsFromEvent(event);
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            let deleteQuery;
            deleteQuery = "CALL public.sp_deleteFile($1::varchar, $2::varchar);"
            pgPool.query(deleteQuery,[onlyFile + '%', params[0]]);
        }

        function renameFileToDB( event: nsfw.RenamedFileEvent) {
            console.log("Rename File");
            console.log(event.directory);
            console.log(event.oldFile);

            console.log(event.newDirectory);
            console.log(event.newFile);
            let params = fetchParamsFromEvent(event);
            const fullfilepath = event.directory + '/' + event.oldFile;
            const newfullfilepath = event.newDirectory + '/' + event.newFile;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const oldFile = fullfilepath.substring(removeNameLength);
            const newFile = newfullfilepath.substring(removeNameLength);

            const updateQuery = "CALL public.sp_updatefilename($1::varchar,$2::varchar,$3::varchar);";
            pgPool.query(updateQuery, [oldFile,newFile, params[0]]);
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
        createWatcher(hostfs + 'tmp/')
        // registerCollab(app);
        app.get('/getWorkspace', (req, res) => {
            if(!req.session.workspace || !req.session.tokens){
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
                let params = decrypt(iv, token);
                console.log("after decrypt");
                console.log(params);
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
                res.statusCode = 301;
                res.redirect('/createTempWorkspace?iv=' + req.query.iv + '&t=' + req.query.t);
                res.end();
        });


        app.get('/setupRSL', (req, res) => {
            if(req.session.workspace) {
                copyRSLFolder(req.session.workspace.foldername)
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });

        app.get('/setupASL', (req, res) => {
            if(req.session.workspace) {
                copyASLFolder(req.session.workspace.foldername)
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });


        app.get('/setupCustom',async (req, res) => {
            let responseItlingoCloud;
            if(req.session.workspace) {
                responseItlingoCloud = await setupCustomFiles(req.session.workspace);
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json(responseItlingoCloud?.data);
            res.end();
        });

        app.get('/setupCustomAccepted',async (req, res) => {
            console.log('setupCustomAccepted');
            console.log(req.query.fileid);
            if(req.session.workspace) {
                 downloadItlingoFiles(req.session.workspace, req.query.filename as string, req.query.fileid as string);
            }
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });


        app.get('/cloneRepo', async (req, res) => {
            if(req.session.workspace) {
                let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
                let jsonData = JSON.parse(Buffer.from(req.query.data as string, "base64").toString());
                let scriptPath = path.join(hostroot, "gitUtils", "cloneScript.sh");
                cp.execSync(`${scriptPath} ${req.session.workspace.foldername} ${jsonData.username} ${jsonData.repository}`);
                let query = 'CALL public.sp_assignGit($1::varchar, $2::varchar)';
                pgPool.query(query, [workspaceName,jsonData.repository] , (err:any, res:any) =>
                {
                    if(err) {
                        console.error("gitCloneDB ERROR");
                        console.error(err.stack);
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end(); 
                        return;
                    }
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end(); 
                });
            }
            
        });


        app.get('/gitCheckout', (req, res) => {
            if(req.session.workspace) {
                console.log("Checkout!!");
                let output = cp.execSync(`cd ${req.session.workspace.foldername} && git checkout ${req.query.data}`).toString();
                if(output === '') output = "Sucess!"
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.json({
                        output: output
                    })
                    res.end(); 
            }
        });

        app.get('/gitBranch', (req, res) => {
            if(req.session.workspace) {
                console.log("Branch!!");
                let output = cp.execSync(`cd ${req.session.workspace.foldername} && git checkout -b ${req.query.data}`).toString();
                if(output === '') output = "Sucess!"
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.json({
                        output: output
                    })
                    res.end(); 
            }
        });


        app.get('/gitPull', (req, res) => {
            if(req.session.workspace) {
                console.log("PULL!!");
                //console.log(`${req.query.repoUrl} `);
                let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
                pgPool.query('SELECT repo FROM public.fn_getgitrepo($1::varchar)', [workspaceName], (err:any, qres:QueryResult) => {
                    if(err){
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end(); 
                    }
                    if(!req.session.workspace) return;
                    console.log(qres.rows[0].repo);
                    let output = cp.execSync(`cd ${req.session.workspace.foldername} && git pull ${qres.rows[0].repo}`).toString();
                    if(output === '') output = "Sucess!"
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.json({
                        output: output
                    })
                    res.end(); 
                });                
            }
            
        });

        app.get('/gitPush',(req, res) => {

            if(req.session.workspace) {
                console.log("PUSSHHH!!");
                let workspaceName = getWorkspaceFromPath(req.session.workspace.foldername);
                //console.log(`${req.query.repoUrl} `);
                pgPool.query('SELECT repo FROM public.fn_getgitrepo($1::varchar)', [workspaceName], (err:any, qres:any) => {
                    if(err){
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end(); 
                    }
                    if(!req.session.workspace) return;
                    console.log(qres.rows[0].repo);
                    let output = cp.execSync(`cd ${req.session.workspace.foldername} && git push ${qres.rows[0].repo}`).toString();
                    if(output === '') output = "Sucess!"
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.json({
                        output: output
                    })
                    res.end(); 
                });                
            }
            
        });
    



        async function setupCustomFiles(editor:Editor){
            let requestURL = itlingoCloudURL + 'token_api/get-file-list/' + editor.workspaceid;
            console.log("CustomRequestURL:" + requestURL);
            return await axios.get<JSON>(requestURL);
        }

        async function downloadItlingoFiles(editor:Editor, filename:string,fileId:string){
            let vUrl =  itlingoCloudURL + 'token_api/download-file/' + editor.workspaceid + '/' + fileId;
            console.log(vUrl);
            axios({
                url: vUrl,
                method: 'GET',
                responseType: 'blob', // important
            }).then((response) => {
                let filenameToWrite = editor.foldername + '/' + filename;
                console.log(filenameToWrite)
                fs.writeFileSync(filenameToWrite, response.data);
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
    if (workspaceExists(params[0])){
        let savedParams = workspaces.get(params[0]) as string[];
        console.log("got saved workspace");
        console.log(params[5]);
        req.session.workspace = {
            workspace: params[0],
            foldername: savedParams[5],
            write: params[3]=="true",
            time: Date.now(),
            workspaceid: Number.parseInt(params[4]),
        };
        return;
    } 
    let wuuid = uuid.v4();
    var randomFoldername = hostfs + 'tmp/' + wuuid + '/'+ params[0];
    req.session.workspace = {
        workspace: params[0],
        foldername: randomFoldername,
        write: params[3]=="true",
        time: Date.now(),
        workspaceid: Number.parseInt(params[4]),
     };
     fs.mkdir(randomFoldername, {recursive: true},(err:any) => {
         if (err) throw err;
     });
    params.push(randomFoldername);
    workspaces.set(params[0], params);
    pullFilesFromDb(randomFoldername,params);
}

function workspaceExists(workspace: string){
    for(const key of workspaces.keys()){
        if(key === workspace) return true;
    }
    return false;
}


    async function  createWatcher(path:string){
        let watcher: nsfw.NSFW | undefined = await nsfw(fs.realpathSync(path), (events: nsfw.FileChangeEvent[]) => {
            for (const event of events) {
                if (event.action === nsfw.actions.CREATED) {
                    console.log('File', path, 'has been added');
                    addFileToDB( event);
                }
                if (event.action === nsfw.actions.DELETED) {
                    console.log('File', path, 'has been removed');
                    deleteFileToDB( event);
                }
                if (event.action === nsfw.actions.MODIFIED) {
                    console.log('File', path, 'has been changed');
                    changeFileToDB( event);
                }
                if (event.action === nsfw.actions.RENAMED) {
                    console.log('File', path, 'has been changed');
                    renameFileToDB( event);
                }
            }
        }, {
                errorCallback: error => {
                    // see https://github.com/atom/github/issues/342
                    console.warn(`Failed to watch "${path}":`, error);
                }
            });
        console.log('created watcher for:' + path);
        await watcher.start();
        return watcher;
    }

    }
}

function getWorkspaceFromPath(foldername: string) : string{
    let arr = foldername.split('/');
    return arr[arr.length-1];
}

