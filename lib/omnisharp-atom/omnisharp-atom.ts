require('./configure-rx');
import _ = require('lodash');
import {Observable, BehaviorSubject, Subject, CompositeDisposable} from "rx";
import path = require('path');
import fs = require('fs');
import a = require("atom");
var Emitter = (<any>a).Emitter

// TODO: Remove these at some point to stream line startup.
import Omni = require('../omni-sharp-server/omni');
import ClientManager = require('../omni-sharp-server/client-manager');
import dependencyChecker = require('./dependency-checker');
import {world} from './world';

class OmniSharpAtom {
    private features: OmniSharp.IFeature[] = [];
    private emitter: EventKit.Emitter;
    private disposable: Rx.CompositeDisposable;
    private autoCompleteProvider;
    private generator: { run(generator: string, path?: string): void; start(prefix: string, path?: string): void; };
    private menu: EventKit.Disposable;

    public editors: Observable<Atom.TextEditor>;
    public configEditors: Observable<Atom.TextEditor>;

    private _activeEditor = new BehaviorSubject<Atom.TextEditor>(null);
    private _activeEditorObservable = this._activeEditor.shareReplay(1);
    public get activeEditor(): Observable<Atom.TextEditor> { return this._activeEditorObservable; }

    public activate(state) {
        this.disposable = new CompositeDisposable;

        if (dependencyChecker.findAllDeps(this.getPackageDir())) {
            this.emitter = new Emitter;

            var editors = new Subject<Atom.TextEditor>();
            this.editors = editors;

            var configEditors = new Subject<Atom.TextEditor>();
            this.configEditors = configEditors;

            this.disposable.add(atom.commands.add('atom-workspace', 'omnisharp-atom:toggle', () => this.toggle()));
            this.disposable.add(atom.commands.add('atom-workspace', 'omnisharp-atom:new-application', () => this.generator.run("aspnet:app")));
            this.disposable.add(atom.commands.add('atom-workspace', 'omnisharp-atom:new-class', () => this.generator.run("aspnet:Class")));
            this.disposable.add(this.emitter);

            Omni.activate(this);

            this.loadAtomFeatures(state).toPromise()
                .then(() => this.loadFeatures(state).toPromise())
                .then(() => {
                    world.activate();
                    _.each(this.features, f => {
                        f.activate();
                        this.disposable.add(f);
                    });

                    ClientManager.activate(this);
                    this.subscribeToEvents();

                    this.disposable.add(atom.workspace.observeTextEditors((editor: Atom.TextEditor) => {
                        var editorFilePath;
                        var grammarName = editor.getGrammar().name;
                        if (grammarName === 'C#' || grammarName === 'C# Script File') {
                            editors.onNext(editor);
                            editorFilePath = editor.buffer.file.path;
                        } else if (grammarName === "JSON") {
                            configEditors.onNext(editor);
                        }

                        this.detectAutoToggleGrammar(editor);
                    }));

                    _.each(this.features, f => {
                        if (_.isFunction(f['attach'])) {
                            f['attach']()
                        }
                    });
                });
        } else {
            _.map(dependencyChecker.errors() || [], missingDependency => console.error(missingDependency))
        }
    }

    public getPackageDir() {
        return _.find(atom.packages.getPackageDirPaths(), function(packagePath) {
            return fs.existsSync(packagePath + "/omnisharp-atom");
        });
    }

    public loadFeatures(state) {
        var packageDir = this.getPackageDir();
        var featureDir = packageDir + "/omnisharp-atom/lib/omnisharp-atom/features";

        var features = Observable.fromNodeCallback(fs.readdir)(featureDir)
            .flatMap(files => Observable.from(files))
            .where(file => /\.js$/.test(file))
            .flatMap(file => Observable.fromNodeCallback(fs.stat)(featureDir + "/" + file).map(stat => ({ file, stat })))
            .where(z => !z.stat.isDirectory())
            .map(z => z.file)
            .map(feature => {
                var path = "./features/" + feature;
                return <OmniSharp.IFeature[]>_.values(require(path))
            });

        var result = features.toArray()
            .map(features => _.flatten<OmniSharp.IFeature>(features));
        result.subscribe(features => {
            this.features = this.features.concat(features);
        });

        return result;
    }

    public loadAtomFeatures(state) {
        var packageDir = this.getPackageDir();
        var atomFeatureDir = packageDir + "/omnisharp-atom/lib/omnisharp-atom/atom";

        var atomFeatures = Observable.fromNodeCallback(fs.readdir)(atomFeatureDir)
            .flatMap(files => Observable.from(files))
            .where(file => /\.js$/.test(file))
            .flatMap(file => Observable.fromNodeCallback(fs.stat)(atomFeatureDir + "/" + file).map(stat => ({ file, stat })))
            .where(z => !z.stat.isDirectory())
            .map(z => z.file)
            .map(feature => {
                var path = "./atom/" + feature;
                return <OmniSharp.IFeature[]>_.values(require(path))
            });

        var result = atomFeatures.toArray()
            .map(features => _.flatten<OmniSharp.IFeature>(features));
        result.subscribe(features => {
            this.features = this.features.concat(features);
        });

        return result;
    }

    public subscribeToEvents() {
        this.disposable.add(atom.workspace.observeActivePaneItem((pane: any) => {
            if (pane && pane.getGrammar) {
                var grammarName = pane.getGrammar().name;
                if (grammarName === 'C#' || grammarName === 'C# Script File') {
                    this._activeEditor.onNext(pane);
                    return;
                }
            }

            // This will tell us when the editor is no longer an appropriate editor
            this._activeEditor.onNext(null);
        }));
    }

    private detectAutoToggleGrammar(editor: Atom.TextEditor) {
        var grammar = editor.getGrammar();
        this.detectGrammar(editor, grammar);
        this.disposable.add(editor.onDidChangeGrammar((grammar: FirstMate.Grammar) => this.detectGrammar(editor, grammar)));
    }

    private detectGrammar(editor: Atom.TextEditor, grammar: FirstMate.Grammar) {
        if (!atom.config.get('omnisharp-atom.autoStartOnCompatibleFile')) {
            return; //short out, if setting to not auto start is enabled
        }

        if (ClientManager.isOn && !this.menu) {
            this.toggleMenu();
        }

        if (grammar.name === 'C#') {
            if (ClientManager.isOff) {
                this.toggle();
            }
        } else if (grammar.name === "JSON") {
            if (path.basename(editor.getPath()) === "project.json") {
                if (ClientManager.isOff) {
                    this.toggle();
                }
            }
        } else if (grammar.name === "C# Script File") {
            if (ClientManager.isOff) {
                this.toggle()
            }
        }
    }

    private toggleMenu() {
        var menuJsonFile = this.getPackageDir() + "/omnisharp-atom/menus/omnisharp-menu.json";
        var menuJson = JSON.parse(fs.readFileSync(menuJsonFile, 'utf8'));
        this.menu = atom.menu.add(menuJson.menu);
        this.disposable.add(this.menu);
    }

    public toggle() {
        var dependencyErrors = dependencyChecker.errors();
        if (dependencyErrors.length === 0) {
            if (ClientManager.isOff) {
                ClientManager.connect();
                this.toggleMenu();
            } else if (ClientManager.isOn) {
                ClientManager.disconnect();

                if (this.menu) {
                    this.disposable.remove(this.menu);
                    this.menu.dispose();
                    this.menu = null;
                }
            }
        } else {
            _.map(dependencyErrors, missingDependency => alert(missingDependency));
        }
    }

    public deactivate() {
        this.features = null;
        this.autoCompleteProvider && this.autoCompleteProvider.destroy();
        ClientManager.disconnect();
    }

    public consumeStatusBar(statusBar) {
        var feature = require('./atom/status-bar');
        feature.statusBar.setup(statusBar);
    }

    public consumeYeomanEnvironment(generatorService: { run(generator: string, path: string): void; start(prefix: string, path: string): void; }) {
        this.generator = generatorService;
    }

    public provideAutocomplete() {
        var {CompletionProvider} = require("./features/lib/completion-provider");
        this.autoCompleteProvider = CompletionProvider;
        return this.autoCompleteProvider;
    }

    public config = {
        autoStartOnCompatibleFile: {
            title: "Autostart Omnisharp Roslyn",
            description: "Automatically starts Omnisharp Roslyn when a compatible file is opened.",
            type: 'boolean',
            default: true
        },
        developerMode: {
            title: 'Developer Mode',
            description: 'Outputs detailed server calls in console.log',
            type: 'boolean',
            default: false
        },
        showDiagnosticsForAllSolutions: {
            title: 'Show Diagnostics for all Solutions',
            description: 'Advanced: This will show diagnostics for all open solutions.  NOTE: May take a restart or change to each server to take effect when turned on.',
            type: 'boolean',
            default: false
        }
    }

}

var instance = new OmniSharpAtom
export = instance;
