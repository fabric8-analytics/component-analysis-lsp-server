/* --------------------------------------------------------------------------------------------
 * Copyright (c) Pavel Odvody 2016
 * Licensed under the Apache-2.0 License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import { StreamingParser, IPosition, IKeyValueEntry, KeyValueEntry, Variant, ValueType } from './json';
import * as Xml2Object from 'xml2object';
import { Stream } from 'stream';

/* By default the collector is going to process these dependency keys */
const DefaultClasses = ["dependencies"];

/* String value with position */
interface IPositionedString {
  value:    string;
  position: IPosition;
}

/* Dependency specification */
interface IDependency {
  name:    IPositionedString;
  version: IPositionedString;
}

/* Dependency collector interface */
interface IDependencyCollector {
  classes: Array<string>;
  collect(file: Stream): Promise<Array<IDependency>>;
}

/* Dependency class that can be created from `IKeyValueEntry` */
class Dependency implements IDependency {
  name:    IPositionedString;
  version: IPositionedString;
  constructor(dependency: IKeyValueEntry) {
    this.name = {
        value: dependency.key, 
        position: dependency.key_position
    }; 
    this.version = {
        value: dependency.value.object, 
        position: dependency.value_position
    }
  }
}

/* Process entries found in the JSON files and collect all dependency
 * related information */
class DependencyCollector implements IDependencyCollector {
    constructor(public classes) {
        this.classes = classes || DefaultClasses
    }

    async collect(file: Stream): Promise<Array<IDependency>> {
        let parser = new StreamingParser(file);
        let dependencies: Array<IDependency> = [];
        let tree = await parser.parse();
        let top_level = tree.children[0];

        /* Iterate over all keys, select those in which we're interested as defined
        by `classes`, and map each item to a new `Dependency` object */
        for (const p of top_level.properties) {
            if (this.classes.indexOf(p.key) > -1) {
                for (const dependency of <[IKeyValueEntry]> p.value.object) {
                    dependencies.push(new Dependency(dependency));
                }
            }
        }

        return dependencies;
    }
}

class NaivePyParser {
    constructor(objSam: any) {
        this.objSam = objSam;
        this.parser = this.createPyParser()
    }

    objSam: any;
    parser: any;
    dependencies: Array<IDependency> = [];
    isDependency: boolean = false;

    createPyParser(): any {
        let deps = this.dependencies;
        this.objSam.forEach(function(obj) {
            let entry: IKeyValueEntry = new KeyValueEntry(obj["pkgName"], {line: 0, column: 0});
                entry.value = new Variant(ValueType.String, obj["version"]);
                entry.value_position = {line: obj["line"], column: obj["pos"]};
                let dep: IDependency = new Dependency(entry);
                deps.push(dep);
        });
    }

     parse(): Array<IDependency> {
        return this.dependencies;
    }
}

let toObject = (arr:any) => {
  let rv: Array<string> =  [];
  for (let i:number = 0; i < arr.length; ++i){
    if (arr[i] !== undefined){
        let line: string = arr[i].replace(/\s/g,'');
        let lineArr: any;
        let lineStr: string;
         if(line.indexOf('#')!== -1){
            lineArr = line.split("#");
            lineStr = lineArr[0];
         }else{
            lineStr = line;
         }
         let subArr: Array<string>  = lineStr.split(/[==,>=]+/);
         let subObj:any = {};
         subObj["pkgName"] = subArr[0];
         subObj["version"] = subArr[1] || "";
         subObj["line"] = i+1;
         subObj["column"] = subArr[0].length +2;
		 rv.push(subObj);
    }
  }
  return rv;
}
/* Process entries found in the txt files and collect all dependency
 * related information */
class ReqDependencyCollector {
    constructor(public classes: Array<string> = ["dependencies"]) {}

    async collect(contents: string): Promise<Array<IDependency>> {
        let tempArr = contents.split("\n");
        let objSam = toObject(tempArr);
        let parser = new NaivePyParser(objSam);
        let dependencies: Array<IDependency> = parser.parse();
        return dependencies;
    }
}

class NaivePomXmlSaxParser {
    constructor(stream: Stream) {
        this.stream = stream;
        this.parser = this.createParser()
    }

    stream: Stream;
    parser: Xml2Object;
    dependencies: Array<IDependency> = [];
    isDependency: boolean = false;
    versionStartLine: number = 0;
    versionStartColumn: number = 0;

    createParser(): Xml2Object {
        let parser = new Xml2Object([ "dependency" ], {strict: true, trackPosition: true});
        let deps = this.dependencies;
        let versionLine = this.versionStartLine;
        let versionColumn = this.versionStartColumn;

        parser.on("object", function (name, obj) {
            if (obj.hasOwnProperty("groupId") && obj.hasOwnProperty("artifactId") && obj.hasOwnProperty("version") && 
                (!obj.hasOwnProperty("scope") || (obj.hasOwnProperty("scope") && obj["scope"] === "compile") || 
                (obj.hasOwnProperty("scope") && obj["scope"] === "runtime"))) {
                let ga = `${obj["groupId"]}:${obj["artifactId"]}`;
                let entry: IKeyValueEntry = new KeyValueEntry(ga, {line: 0, column: 0});
                entry.value = new Variant(ValueType.String, obj["version"]);
                entry.value_position = {line: versionLine, column: versionColumn};
                let dep: IDependency = new Dependency(entry);
                deps.push(dep)
            }
        });
        parser.saxStream.on("opentag", function (node) {
            if (node.name == "dependency") {
                this.isDependency = true;
            }
            if (this.isDependency && node.name == "version") {
                versionLine = parser.saxStream._parser.line + 1;
                versionColumn = parser.saxStream._parser.column +1;
            }
        });
        parser.saxStream.on("closetag", function (nodeName) {
            // TODO: nested deps!
            if (nodeName == "dependency") {
                this.isDependency = false;
            }
        });
        parser.on("error", function (e) {
            // the XML document doesn't have to be well-formed, that's fine
            parser.error = null;
        });
        parser.on("end", function () {
            // the XML document doesn't have to be well-formed, that's fine
            // parser.error = null;
            this.dependencies = deps;
        });
        return parser
    }

    async parse() {
        return new Promise(resolve => {
            this.stream.pipe(this.parser.saxStream).on('end', (data) => {
                resolve(this.dependencies);
           });
        });
        
    }
}

class PomXmlDependencyCollector {
    constructor(public classes: Array<string> = ["dependencies"]) {}

    async collect(file: Stream): Promise<Array<IDependency>> {
        let parser = new NaivePomXmlSaxParser(file);
        let dependencies;
         await parser.parse().then(data => {
            dependencies = data;
        });
        return dependencies || [];
    }
}

export { IDependencyCollector, DependencyCollector, PomXmlDependencyCollector, ReqDependencyCollector, IPositionedString, IDependency };
