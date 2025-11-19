import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  editorInfoField,
} from 'obsidian';
import { StateEffect, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import micromatch from 'micromatch';
import { BareunClient } from './bareunClient';
import { DEFAULT_BAREUN_REVISION_ENDPOINT } from './constants';
import { ProcessedIssue, refineIssues, buildLocalHeuristics } from './diagnostics';

interface BkgaSettings {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  includeGlobs: string[];
  ignoreEnglish: boolean;
  debounceMs: number;
}

const DEFAULT_SETTINGS: BkgaSettings = {
  enabled: true,
  apiKey: '',
  endpoint: '',
  includeGlobs: ['**/*.md'],
  ignoreEnglish: true,
  debounceMs: 500,
};

const diagnosticsEffect = StateEffect.define<null>();

export default class BareunObsidianPlugin extends Plugin {
  settings: BkgaSettings = DEFAULT_SETTINGS;
  private diagnostics = new Map<string, ProcessedIssue[]>();
  private cmViews = new Set<EditorView>();
  private statusBarEl: HTMLElement | null = null;
  private pendingTimers = new Map<string, number>();

  async onload() {
    await this.loadSettings();
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatus('Idle');

    this.registerEditorExtension(createDecorationExtension(this));

    this.addSettingTab(new BkgaSettingTab(this.app, this));

    this.addCommand({
      id: 'bkga-analyze-active-note',
      name: 'Run grammar assistant on current note',
      callback: () => {
        void this.runActiveAnalysis(true);
      },
    });

    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, view) => {
        if (view instanceof MarkdownView && view.file) {
          this.queueAnalysis(view.file, editor);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) {
          void this.runAnalysisForFile(file, false);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file) {
          void this.runAnalysisForFile(view.file, false);
        }
      })
    );

    // Initial analysis to prime diagnostics
    await this.runActiveAnalysis(false);
  }

  onunload() {
    this.pendingTimers.forEach((timer) => window.clearTimeout(timer));
    this.pendingTimers.clear();
  }

  trackEditorView(view: EditorView) {
    this.cmViews.add(view);
  }

  untrackEditorView(view: EditorView) {
    this.cmViews.delete(view);
  }

  signalDiagnosticsChanged() {
    for (const view of this.cmViews) {
      view.dispatch({ effects: diagnosticsEffect.of(null) });
    }
  }

  getDiagnostics(path: string): ProcessedIssue[] {
    return this.diagnostics.get(path) ?? [];
  }

  private queueAnalysis(file: TFile, editor: Editor) {
    if (!this.shouldAnalyze(file)) {
      return;
    }
    const path = file.path;
    const existing = this.pendingTimers.get(path);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.pendingTimers.delete(path);
      this.runAnalysis(path, editor.getValue()).catch((err) => console.error('[BKGA] Analysis failed', err));
    }, this.settings.debounceMs);
    this.pendingTimers.set(path, timer);
  }

  private async runActiveAnalysis(showNotice: boolean) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      return;
    }
    await this.runAnalysisForFile(view.file, showNotice);
  }

  private async runAnalysisForFile(file: TFile, showNotice: boolean) {
    if (!this.shouldAnalyze(file)) {
      this.clearDiagnostics(file.path);
      return;
    }
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const text = mdView?.editor?.getValue() ?? (await this.app.vault.read(file));
    await this.runAnalysis(file.path, text, showNotice);
  }

  private async runAnalysis(path: string, text: string, showNotice = false) {
    if (!this.settings.enabled) {
      this.clearDiagnostics(path);
      this.updateStatus('Disabled');
      return;
    }

    const endpoint = (this.settings.endpoint || '').trim() || DEFAULT_BAREUN_REVISION_ENDPOINT;
    const apiKey = this.settings.apiKey.trim();

    this.updateStatus('Analyzing...');

    try {
      let issues: ProcessedIssue[] = [];
      if (!apiKey) {
        issues = buildLocalHeuristics(text);
        this.updateStatus('API key required (local)');
        if (showNotice) {
          new Notice('Bareun API key missing; running local heuristics only.');
        }
      } else {
        const raw = await BareunClient.analyze(endpoint, apiKey, text);
        issues = refineIssues(text, raw, { ignoreEnglish: this.settings.ignoreEnglish });
        if (issues.length) {
          const label = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
          this.updateStatus(label);
        } else {
          this.updateStatus('No issues');
        }
      }
      this.diagnostics.set(path, issues);
      this.signalDiagnosticsChanged();
    } catch (err) {
      console.error('[BKGA] Bareun analysis error', err);
      const fallback = buildLocalHeuristics(text);
      this.diagnostics.set(path, fallback);
      this.signalDiagnosticsChanged();
      this.updateStatus('API error (local)');
      if (showNotice) {
        new Notice('Bareun API request failed; showing local heuristics.');
      }
    }
  }

  private clearDiagnostics(path: string) {
    if (this.diagnostics.delete(path)) {
      this.signalDiagnosticsChanged();
    }
  }

  private shouldAnalyze(file: TFile): boolean {
    if (file.extension !== 'md') {
      return false;
    }
    if (!this.settings.includeGlobs.length) {
      return true;
    }
    return micromatch.isMatch(file.path, this.settings.includeGlobs);
  }

  updateStatus(text: string) {
    if (this.statusBarEl) {
      this.statusBarEl.setText(`BKGA: ${text}`);
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
  }

  async saveBkgaSettings() {
    await this.saveData(this.settings);
  }
}

class BkgaSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BareunObsidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Grammar assistant').setHeading();

    new Setting(containerEl)
      .setName('Enable extension')
      .setDesc('Turn on automatic analysis.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveBkgaSettings();
          if (!value) {
            this.plugin.updateStatus('Disabled');
          } else {
            this.plugin.updateStatus('Idle');
          }
        })
      );

    new Setting(containerEl)
      .setName('Bareun API key')
      .setDesc('Enter the API key issued at https://bareun.ai.')
      .addText((text) =>
        text
          .setPlaceholder('Example: bareun_abc123')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveBkgaSettings();
          })
      );

    new Setting(containerEl)
      .setName('Bareun endpoint')
      .setDesc('Leave empty to use the default cloud endpoint.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_BAREUN_REVISION_ENDPOINT)
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim();
            await this.plugin.saveBkgaSettings();
          })
      );

    new Setting(containerEl)
      .setName('Analysis paths')
      .setDesc('Micromatch patterns, e.g., content/**/*.md.')
      .addText((text) =>
        text
          .setPlaceholder('Comma-separated glob patterns')
          .setValue(this.plugin.settings.includeGlobs.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.includeGlobs = value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
            await this.plugin.saveBkgaSettings();
          })
      );

    new Setting(containerEl)
      .setName('Ignore english-heavy text')
      .setDesc('Skip diagnostics for spans that contain mostly english text.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreEnglish).onChange(async (value) => {
          this.plugin.settings.ignoreEnglish = value;
          await this.plugin.saveBkgaSettings();
        })
      );

    new Setting(containerEl)
      .setName('Auto-analysis delay (ms)')
      .setDesc('Lower values trigger checks sooner after edits.')
      .addSlider((slider) =>
        slider
          .setLimits(200, 2000, 50)
          .setValue(this.plugin.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.debounceMs = value;
            await this.plugin.saveBkgaSettings();
          })
      );
  }
}

function createDecorationExtension(plugin: BareunObsidianPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(private view: EditorView) {
        plugin.trackEditorView(view);
        this.decorations = this.buildDecorations();
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(diagnosticsEffect)))
        ) {
          this.decorations = this.buildDecorations();
        }
      }

      destroy() {
        plugin.untrackEditorView(this.view);
      }

      private buildDecorations(): DecorationSet {
        const filePath = getFilePath(this.view);
        if (!filePath) {
          return Decoration.none;
        }
        const issues = plugin.getDiagnostics(filePath);
        if (!issues.length) {
          return Decoration.none;
        }
        const builder = new RangeSetBuilder<Decoration>();
        const docLength = this.view.state.doc.length;
        for (const issue of issues) {
          const from = clamp(issue.start, 0, docLength);
          const to = clamp(issue.end, 0, docLength);
          if (to <= from) {
            continue;
          }
          const deco = Decoration.mark({
            class: `bkga-underline ${categoryToClass(issue.category)}`,
            attributes: {
              title: issue.suggestion && issue.suggestion !== ''
                ? `${issue.message}\nSuggestion: ${issue.suggestion}`
                : issue.message,
            },
          });
          builder.add(from, to, deco);
        }
        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function categoryToClass(category: string): string {
  const normalized = (category || '').toUpperCase();
  if (normalized.includes('SPELLING') || normalized.includes('맞춤법') || normalized.includes('TYPO')) {
    return 'bkga-spelling';
  }
  if (normalized.includes('SPACING') || normalized.includes('띄어쓰기')) {
    return 'bkga-spacing';
  }
  if (normalized.includes('STANDARD') || normalized.includes('표준어')) {
    return 'bkga-standard';
  }
  if (normalized.includes('STATISTICAL') || normalized.includes('통계')) {
    return 'bkga-statistical';
  }
  return 'bkga-default';
}

function getFilePath(view: EditorView): string | null {
  const info = view.state.field(editorInfoField, false) as { file?: TFile } | undefined;
  return info?.file?.path ?? null;
}
