/* --------------------------------------------------------------------------------------------
 * Copyright (c) Pavel Odvody 2016
 * Licensed under the Apache-2.0 License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import * as path from 'path';
import * as fs from 'fs';
import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection,
	TextDocuments, Diagnostic, InitializeResult, CodeLens, CodeAction, RequestHandler, CodeActionParams
} from 'vscode-languageserver';
import { stream_from_string } from './utils';
import { DependencyCollector, IDependency, PomXmlDependencyCollector, ReqDependencyCollector } from './collector';
import { EmptyResultEngine, SecurityEngine, DiagnosticsPipeline, codeActionsMap } from './consumers';

const url = require('url');
const https = require('https');
const request = require('request');
const winston = require('winston');

 winston.level = 'debug';
 winston.add(winston.transports.File, { filename: '/workspace-logs/ls-bayesian/bayesian.log' });
 winston.remove(winston.transports.Console);
 winston.info('Starting Bayesian');

/*
let log_file = fs.openSync('file_log.log', 'w');
let _LOG = (data) => {
    fs.writeFileSync('file_log.log', data + '\n');
}
*/

enum EventStream {
  Invalid,
  Diagnostics,
  CodeLens
};

let connection: IConnection = null;
/* use stdio for transfer if applicable */
if (process.argv.indexOf('--stdio') == -1)
    connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
else
    connection = createConnection()

let documents: TextDocuments = new TextDocuments();
documents.listen(connection);

let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            codeActionProvider: true
        }
    }
});

interface IFileHandlerCallback {
    (uri: string, name: string, contents: string): void;
};

interface IAnalysisFileHandler {
    matcher:  RegExp;
    stream: EventStream;
    callback: IFileHandlerCallback;
};

interface IAnalysisFiles {
    handlers: Array<IAnalysisFileHandler>;
    file_data: Map<string, string>;
    on(stream: EventStream, matcher: string, cb: IFileHandlerCallback): IAnalysisFiles;
    run(stream: EventStream, uri: string, file: string, contents: string): any;
};

class AnalysisFileHandler implements IAnalysisFileHandler {
    matcher: RegExp;
    constructor(matcher: string, public stream: EventStream, public callback: IFileHandlerCallback) {
        this.matcher = new RegExp(matcher);
    }
};

class AnalysisFiles implements IAnalysisFiles {
    handlers: Array<IAnalysisFileHandler>;
    file_data: Map<string, string>;
    constructor() {
        this.handlers = [];
        this.file_data = new Map<string, string>();
    }
    on(stream: EventStream, matcher: string, cb: IFileHandlerCallback): IAnalysisFiles {
        this.handlers.push(new AnalysisFileHandler(matcher, stream, cb));
        return this;
    }
    run(stream: EventStream, uri: string, file: string, contents: string): any {
        for (let handler of this.handlers) {
            if (handler.stream == stream && handler.matcher.test(file)) {
                return handler.callback(uri, file, contents);
            }
        }
    }
};

interface IAnalysisLSPServer
{
    connection: IConnection;
    files:      IAnalysisFiles;

    handle_file_event(uri: string, contents: string): void;
    handle_code_lens_event(uri: string): CodeLens[];
};

class AnalysisLSPServer implements IAnalysisLSPServer {
    constructor(public connection: IConnection, public files: IAnalysisFiles) {}

    handle_file_event(uri: string, contents: string): void {
        let path_name = url.parse(uri).pathname;
        let file_name = path.basename(path_name);

        this.files.file_data[uri] = contents;

        this.files.run(EventStream.Diagnostics, uri, file_name, contents);
    }

    handle_code_lens_event(uri: string): CodeLens[] {
        let path_name = url.parse(uri).pathname;
        let file_name = path.basename(path_name);
        let lenses = [];
        let contents = this.files.file_data[uri];
        return this.files.run(EventStream.CodeLens, uri, file_name, contents);
    }
};

interface IAggregator
{
    callback: any;
    is_ready(): boolean;
    aggregate(IDependency): void;
};

class Aggregator implements IAggregator
{
    mapping: Map<IDependency, boolean>;
    diagnostics: Array<Diagnostic>;
    constructor(items: Array<IDependency>, public callback: any){
        this.mapping = new Map<IDependency, boolean>();
        for (let item of items) {
            this.mapping.set(item, false);
        }
    }
    is_ready(): boolean {
        let val = true;
        for (let m of this.mapping.entries()) {
            val = val && m[1];
        }
        return val;
    }
    aggregate(dep: IDependency): void {
        this.mapping.set(dep, true);
        if (this.is_ready()) {
            this.callback();
        }
    }
};

class AnalysisConfig
{
    server_url:         string;
    api_token:          string;
    three_scale_user_token:          string;
    forbidden_licenses: Array<string>;
    no_crypto:          boolean;
    home_dir:           string;

    constructor() {
        // TODO: this needs to be configurable
        this.server_url = process.env.RECOMMENDER_API_URL || "api-url-not-available-in-lsp";
        this.api_token = process.env.RECOMMENDER_API_TOKEN || "token-not-available-in-lsp";
        this.three_scale_user_token = process.env.THREE_SCALE_USER_TOKEN || "";
        this.forbidden_licenses = [];
        this.no_crypto = false;
        this.home_dir = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
    }
};

let config: AnalysisConfig = new AnalysisConfig();
let files: IAnalysisFiles = new AnalysisFiles();
let server: IAnalysisLSPServer = new AnalysisLSPServer(connection, files);
let rc_file = path.join(config.home_dir, '.analysis_rc');
if (fs.existsSync(rc_file)) {
    let rc = JSON.parse(fs.readFileSync(rc_file, 'utf8'));
    if ('server' in rc) {
        config.server_url = `${rc.server}/api/v1`;
    }
}

let DiagnosticsEngines = [SecurityEngine];

const getCAmsg = (deps, diagnostics): string => {
    if(diagnostics.length > 0) {
        return `Scanned ${deps.length} runtime dependencies, flagged ${diagnostics.length} potential security vulnerabilities along with quick fixes`;
    } else {
        return `Scanned ${deps.length} runtime dependencies. No potential security vulnerabilities found`;
    }
};

const caDefaultMsg = 'Checking for security vulnerabilities ...';

let metadataCache = new Map();
let get_metadata = (ecosystem, name, version) => {
    return new Promise((resolve, reject) => {
        let cacheKey = ecosystem + " " + name + " " + version;
        let metadata = metadataCache[cacheKey];
        if (metadata != null) {
            winston.info('cache hit for ' + cacheKey);
            connection.console.log('cache hit for ' + cacheKey);
            resolve(metadata);
        } else {
            let part = [ecosystem, name, version].join('/');
            const options = {};
                options['url'] = config.server_url;
                if(config.three_scale_user_token){
                    options['url'] += `/component-analyses/${part}?user_key=${config.three_scale_user_token}`;
                } else{
                    options['url'] += `/component-analyses/${part}/`;
                }
                options['headers'] = {
                    'Authorization' : 'Bearer ' + config.api_token,
                };
            winston.debug('get ' + options['url']);
            connection.console.log('Scanning ' + part);
            if(process.env.RECOMMENDER_API_URL){
                request.get(options, (err, httpResponse, body) => {
                    if(err){
                        reject(err);
                    } else {
                        if ((httpResponse.statusCode === 200 || httpResponse.statusCode === 202)) {
                            let response = JSON.parse(body);
                            winston.debug('response ' + response);
                            metadataCache[cacheKey] = response;
                            resolve(response);
                        } else if(httpResponse.statusCode === 401){
                            reject(httpResponse.statusCode);
                        } else if(httpResponse.statusCode === 429 || httpResponse.statusCode === 403){
                            reject(httpResponse.statusCode);
                        } else if(httpResponse.statusCode === 400){
                            reject(httpResponse.statusCode);
                        } else {
                            reject(httpResponse.statusCode);
                        }
                    }
                });
            }
        }
    });
};


files.on(EventStream.Diagnostics, "^package\\.json$", (uri, name, contents) => {
    /* Convert from readable stream into string */
    let stream = stream_from_string(contents);
    let collector = new DependencyCollector(null);
    connection.sendNotification('caNotification', {'data': caDefaultMsg});

    collector.collect(stream).then((deps) => {
        let diagnostics = [];
        /* Aggregate asynchronous requests and send the diagnostics at once */
        let aggregator = new Aggregator(deps, () => {
            connection.sendNotification('caNotification', {'data': getCAmsg(deps, diagnostics), 'diagCount' : diagnostics.length > 0? diagnostics.length : 0});
            connection.sendDiagnostics({uri: uri, diagnostics: diagnostics});
        });
        const regexVersion =  new RegExp(/^([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+)$/);
        for (let dependency of deps) {
            if(dependency.name.value && dependency.version.value && regexVersion.test(dependency.version.value)) {
                get_metadata('npm', dependency.name.value, dependency.version.value).then((response) => {
                    if (response != null) {
                        let pipeline = new DiagnosticsPipeline(DiagnosticsEngines, dependency, config, diagnostics, uri);
                        pipeline.run(response);
                    }
                    aggregator.aggregate(dependency);
                }).catch((err)=>{
                    connection.console.log(err);
                });
            } else {
                aggregator.aggregate(dependency);
            }
        }
    });
});

files.on(EventStream.Diagnostics, "^pom\\.xml$", (uri, name, contents) => {
    /* Convert from readable stream into string */
    let stream = stream_from_string(contents);
    let collector = new PomXmlDependencyCollector();
    connection.sendNotification('caNotification', {'data': caDefaultMsg});

    collector.collect(stream).then((deps) => {
        let diagnostics = [];
        /* Aggregate asynchronous requests and send the diagnostics at once */
        let aggregator = new Aggregator(deps, () => {
            connection.sendNotification('caNotification', {'data': getCAmsg(deps, diagnostics), 'diagCount' : diagnostics.length > 0? diagnostics.length : 0});
            connection.sendDiagnostics({uri: uri, diagnostics: diagnostics});
        });
        const regexVersion =  new RegExp(/^([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+)$/);
        for (let dependency of deps) {
            if(dependency.name.value && dependency.version.value && regexVersion.test(dependency.version.value)) {
                get_metadata('maven', dependency.name.value, dependency.version.value).then((response) => {
                    if (response != null) {
                        let pipeline = new DiagnosticsPipeline(DiagnosticsEngines, dependency, config, diagnostics, uri);
                        pipeline.run(response);
                    }
                    aggregator.aggregate(dependency);
                }).catch((err)=>{
                    connection.console.log(err);
                });
            } else {
                aggregator.aggregate(dependency);
            }
        }
    });
});

files.on(EventStream.Diagnostics, "^requirements\\.txt$", (uri, name, contents) => {
    let collector = new ReqDependencyCollector();
    connection.sendNotification('caNotification', {'data': caDefaultMsg});

    collector.collect(contents).then((deps) => {
        let diagnostics = [];
        /* Aggregate asynchronous requests and send the diagnostics at once */
        let aggregator = new Aggregator(deps, () => {
            connection.sendNotification('caNotification', {'data': getCAmsg(deps, diagnostics), 'diagCount' : diagnostics.length > 0? diagnostics.length : 0});
            connection.sendDiagnostics({uri: uri, diagnostics: diagnostics});
        });
        const regexVersion =  new RegExp(/^([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+\.)?([a-zA-Z0-9]+)$/);
        for (let dependency of deps) {
            winston.info('python cmp name'+ dependency.name.value);
            if(dependency.name.value && dependency.version.value && regexVersion.test(dependency.version.value.trim())) {
                get_metadata('pypi', dependency.name.value, dependency.version.value).then((response) => {
                    if (response != null) {
                        let pipeline = new DiagnosticsPipeline(DiagnosticsEngines, dependency, config, diagnostics, uri);
                        pipeline.run(response);
                    }
                    aggregator.aggregate(dependency);
                }).catch((err)=>{
                    connection.console.log(err);
                });
            } else {
                aggregator.aggregate(dependency);
            }
        }
    });
});

let checkDelay;
connection.onDidSaveTextDocument((params) => {
    clearTimeout(checkDelay);
    server.handle_file_event(params.textDocument.uri, server.files.file_data[params.textDocument.uri]);
});

connection.onDidChangeTextDocument((params) => {
    /* Update internal state for code lenses */
    server.files.file_data[params.textDocument.uri] = params.contentChanges[0].text;
    clearTimeout(checkDelay);
    checkDelay = setTimeout(() => {
        server.handle_file_event(params.textDocument.uri, server.files.file_data[params.textDocument.uri])
    }, 500)
});

connection.onDidOpenTextDocument((params) => {
    server.handle_file_event(params.textDocument.uri, params.textDocument.text);
});

connection.onCodeAction((params, token): CodeAction[] => {
    clearTimeout(checkDelay);
    let codeActions: CodeAction[] = [];
    for (let diagnostic of params.context.diagnostics) {
        let codeAction = codeActionsMap[diagnostic.message];
        if (codeAction != null) {
            codeActions.push(codeAction)
        }
    }
    return codeActions;
});

connection.onDidCloseTextDocument((params) => {
    clearTimeout(checkDelay);
});

connection.listen();
