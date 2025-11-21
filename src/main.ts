import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  ItemView,
  WorkspaceLeaf,
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
  cooldownMs: number;
  analysisTrigger: 'realtime' | 'manual';
}

const DEFAULT_SETTINGS: BkgaSettings = {
  enabled: true,
  apiKey: '',
  endpoint: '',
  includeGlobs: ['**/*.md'],
  ignoreEnglish: true,
  debounceMs: 1200,
  cooldownMs: 5000,
  analysisTrigger: 'realtime',
};

const diagnosticsEffect = StateEffect.define<null>();
const BKGA_ISSUES_VIEW_TYPE = 'bkga-issues-view';

export default class BareunObsidianPlugin extends Plugin {
  settings: BkgaSettings = DEFAULT_SETTINGS;
  private diagnostics = new Map<string, ProcessedIssue[]>();
  private diagnosticsListeners = new Set<() => void>();
  private cmViews = new Set<EditorView>();
  private statusBarEl: HTMLElement | null = null;
  private pendingTimers = new Map<string, number>();
  private latestRunToken = new Map<string, number>();
  private lastRunAt = new Map<string, number>();
  private disabledCategories = new Set<string>();
  private lastContent = new Map<string, string>();

  async onload() {
    await this.loadSettings();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('bkga-status');
    this.statusBarEl.addEventListener('click', () => {
      void this.openIssuesView();
    });
    this.updateStatus('Idle');

    this.registerView(BKGA_ISSUES_VIEW_TYPE, (leaf) => new BkgaIssuesView(leaf, this));
    this.registerEditorExtension(createDecorationExtension(this));

    this.addSettingTab(new BkgaSettingTab(this.app, this));

    this.addCommand({
      id: 'bkga-analyze-active-note',
      name: 'Run grammar assistant on current note',
      callback: () => {
        void this.runActiveAnalysis(true);
      },
    });

    this.addCommand({
      id: 'bkga-open-issues',
      name: 'Show BKGA issues panel',
      callback: () => {
        void this.openIssuesView();
      },
    });

    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, view) => {
        if (this.settings.analysisTrigger !== 'realtime') {
          return;
        }
        if (view instanceof MarkdownView && view.file) {
          this.queueAnalysis(view.file, editor);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (this.settings.analysisTrigger !== 'realtime') {
          return;
        }
        if (file) {
          void this.runAnalysisForFile(file, false);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        if (this.settings.analysisTrigger !== 'realtime') {
          return;
        }
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file) {
          void this.runAnalysisForFile(view.file, false);
        }
      })
    );

    // Initial analysis to prime diagnostics (skip in manual mode)
    if (this.settings.analysisTrigger === 'realtime') {
      await this.runActiveAnalysis(false);
    } else {
      this.updateStatus('Manual');
    }
  }

  onunload() {
    this.pendingTimers.forEach((timer) => window.clearTimeout(timer));
    this.pendingTimers.clear();
    this.app.workspace.detachLeavesOfType(BKGA_ISSUES_VIEW_TYPE);
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
    for (const listener of this.diagnosticsListeners) {
      listener();
    }
  }

  getDiagnostics(path: string): ProcessedIssue[] {
    return this.diagnostics.get(path) ?? [];
  }

  getCachedContent(path: string): string | null {
    return this.lastContent.get(path) ?? null;
  }

  onDiagnosticsChanged(listener: () => void): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  private isStaleRun(path: string, token: number): boolean {
    return this.latestRunToken.get(path) !== token;
  }

  isCategoryEnabled(issue: ProcessedIssue): boolean {
    const key = categoryKey(issue.category);
    return !this.disabledCategories.has(key);
  }

  isCategoryKeyEnabled(key: string): boolean {
    return !this.disabledCategories.has(key);
  }

  toggleCategory(key: string) {
    if (this.disabledCategories.has(key)) {
      this.disabledCategories.delete(key);
    } else {
      this.disabledCategories.add(key);
    }
    this.signalDiagnosticsChanged();
  }

  resetCategoryFilters() {
    if (this.disabledCategories.size === 0) {
      return;
    }
    this.disabledCategories.clear();
    this.signalDiagnosticsChanged();
  }

  async openIssuesView() {
    const existing = this.app.workspace.getLeavesOfType(BKGA_ISSUES_VIEW_TYPE)[0];
    const targetLeaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!targetLeaf) {
      new Notice('Unable to open BKGA issues view.');
      return;
    }
    await targetLeaf.setViewState({ type: BKGA_ISSUES_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(targetLeaf);
  }

  private queueAnalysis(file: TFile, editor: Editor) {
    if (!this.shouldAnalyze(file)) {
      return;
    }
    if (this.settings.analysisTrigger !== 'realtime') {
      return;
    }
    const path = file.path;
    const existing = this.pendingTimers.get(path);
    if (existing) {
      window.clearTimeout(existing);
    }
    const now = Date.now();
    const debounceTarget = now + this.settings.debounceMs;
    const cooldownTarget = (this.lastRunAt.get(path) ?? 0) + this.settings.cooldownMs;
    const due = Math.max(debounceTarget, cooldownTarget);
    const delay = Math.max(0, due - now);

    const timer = window.setTimeout(() => {
      this.pendingTimers.delete(path);
      this.runAnalysis(path, editor.getValue()).catch((err) => console.error('[BKGA] Analysis failed', err));
    }, delay);
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
    const runToken = (this.latestRunToken.get(path) ?? 0) + 1;
    this.latestRunToken.set(path, runToken);
    this.lastContent.set(path, text);
    this.lastRunAt.set(path, Date.now());

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
        if (!this.isStaleRun(path, runToken)) {
          this.updateStatus('API key required (local)');
        }
        if (showNotice) {
          new Notice('Bareun API key missing; running local heuristics only.');
        }
      } else {
        const raw = await BareunClient.analyze(endpoint, apiKey, text);
        issues = refineIssues(text, raw, { ignoreEnglish: this.settings.ignoreEnglish });
        if (issues.length) {
          const label = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
          if (!this.isStaleRun(path, runToken)) {
            this.updateStatus(label);
          }
        } else {
          if (!this.isStaleRun(path, runToken)) {
            this.updateStatus('No issues');
          }
        }
      }
      if (!this.isStaleRun(path, runToken)) {
        this.diagnostics.set(path, issues);
        this.signalDiagnosticsChanged();
      }
    } catch (err) {
      console.error('[BKGA] Bareun analysis error', err);
      if (!this.isStaleRun(path, runToken)) {
        const fallback = buildLocalHeuristics(text);
        this.diagnostics.set(path, fallback);
        this.signalDiagnosticsChanged();
        this.updateStatus('API error (local)');
        if (showNotice) {
          new Notice('Bareun API request failed; showing local heuristics.');
        }
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
    const loaded = ((await this.loadData()) ?? {}) as Partial<BkgaSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
  }

  async saveBkgaSettings() {
    await this.saveData(this.settings);
  }
}

class BkgaIssuesView extends ItemView {
  private cleanup: Array<() => void> = [];
  private lastEditor: Editor | null = null;
  private lastFilePath: string | null = null;
  private lastRenderedPath: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: BareunObsidianPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return BKGA_ISSUES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'BKGA Issues';
  }

  getIcon(): string {
    return 'spell-check';
  }

  async onOpen() {
    this.cleanup.push(this.plugin.onDiagnosticsChanged(() => this.renderIssues()));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const activePath = this.app.workspace.getActiveFile()?.path ?? null;
        if (activePath === this.lastRenderedPath) {
          return;
        }
        this.renderIssues();
      })
    );
    this.renderIssues();
  }

  async onClose() {
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
  }

  private renderIssues() {
    const container = this.containerEl;
    container.empty();
    container.addClass('bkga-issues-view');

    const file = this.app.workspace.getActiveFile();
    this.lastRenderedPath = file?.path ?? null;
    const issues = file
      ? this.plugin.getDiagnostics(file.path).filter((i) => this.plugin.isCategoryEnabled(i))
      : [];
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = mdView?.editor;
    const cachedContent = file ? this.plugin.getCachedContent(file.path) : null;
    this.lastEditor = editor ?? null;
    this.lastFilePath = file?.path ?? null;

    if (!file) {
      container.createDiv({ cls: 'bkga-empty', text: 'Open a Markdown note to see BKGA issues.' });
      return;
    }

    const header = container.createDiv({ cls: 'bkga-issues-header' });
    header.createDiv({ cls: 'bkga-issues-title', text: file.name });
    header.createDiv({
      cls: 'bkga-issues-count',
      text: issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}` : 'No issues',
    });

    const legend = container.createDiv({ cls: 'bkga-issues-legend' });
    [
      { cat: 'TYPO', cls: 'bkga-spelling' },
      { cat: 'SPACING', cls: 'bkga-spacing' },
      { cat: 'STANDARD', cls: 'bkga-standard' },
      { cat: 'STATISTICAL', cls: 'bkga-statistical' },
      { cat: 'DEFAULT', cls: 'bkga-default' },
    ].forEach((entry) => {
      const active = this.plugin.isCategoryKeyEnabled(categoryKey(entry.cat));
      const badge = legend.createSpan({
        cls: `bkga-badge ${entry.cls} ${active ? '' : 'inactive'}`,
        text: categoryLabel(entry.cat),
      });
      badge.setAttr('title', `${categoryTooltip(entry.cat)} (click to toggle)`);
      badge.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        this.plugin.toggleCategory(categoryKey(entry.cat));
        this.renderIssues();
      });
    });
    const reset = legend.createSpan({
      cls: 'bkga-reset',
      text: '모두 표시',
    });
    reset.setAttr('title', '숨긴 카테고리를 모두 다시 표시');
    reset.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      this.plugin.resetCategoryFilters();
      this.renderIssues();
    });

    if (!issues.length) {
      container.createDiv({ cls: 'bkga-empty', text: 'This note has no BKGA issues.' });
      return;
    }

    const list = container.createDiv({ cls: 'bkga-issues-list' });
    issues.forEach((issue, idx) => {
      const item = list.createDiv({ cls: 'bkga-issue-item' });
      const title = item.createDiv({ cls: 'bkga-issue-title' });
      title.createSpan({ cls: 'bkga-issue-index', text: `${idx + 1}.` });
      const badge = title.createSpan({
        cls: `bkga-badge ${categoryToClass(issue.category)}`,
        text: categoryLabel(issue.category),
      });
      badge.setAttr('title', categoryTooltip(issue.category));
      title.createSpan({
        cls: 'bkga-issue-message',
        text: issue.message || categoryLabel(issue.category),
      });
      const position = this.formatPosition(editor, cachedContent, issue.start, issue.end);
      if (position) {
        title.createSpan({ cls: 'bkga-issue-pos', text: position });
      }

      if (issue.snippet) {
        const origEl = item.createDiv({ cls: 'bkga-issue-suggestion-row' });
        origEl.createSpan({ cls: 'bkga-issue-suggestion-label', text: '기존:' });
        origEl.createSpan({ cls: 'bkga-issue-suggestion-text', text: issue.snippet });
      }

      if (issue.suggestion && issue.suggestion !== '') {
        const suggestionEl = item.createDiv({ cls: 'bkga-issue-suggestion-row' });
        suggestionEl.createSpan({ cls: 'bkga-issue-suggestion-label', text: '제안:' });
        suggestionEl.createSpan({ cls: 'bkga-issue-suggestion-text', text: issue.suggestion });
        const applyBtn = suggestionEl.createEl('button', { cls: 'bkga-apply-btn', text: '적용' });
        applyBtn.addEventListener('mousedown', (evt) => {
          evt.preventDefault();
          this.applySuggestion(issue);
        });
      }

      item.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        this.jumpToIssue(issue);
      });
    });
  }

  private formatPosition(
    editor: Editor | undefined,
    cached: string | null,
    start: number,
    end: number
  ): string {
    if (editor) {
      const docLength = editor.getValue().length;
      const from = editor.offsetToPos(clamp(start, 0, docLength));
      const to = editor.offsetToPos(clamp(end, 0, docLength));
      const main = `L${from.line + 1}:${from.ch + 1}`;
      const suffix =
        to.line !== from.line || to.ch !== from.ch ? `-L${to.line + 1}:${to.ch + 1}` : '';
      return main + suffix;
    }
    if (cached) {
      const info = offsetToLineCol(cached, start, end);
      if (info) {
        const main = `L${info.from.line}:${info.from.ch}`;
        const suffix =
          info.to.line !== info.from.line || info.to.ch !== info.from.ch
            ? `-L${info.to.line}:${info.to.ch}`
            : '';
        return main + suffix;
      }
    }
    return '';
  }

  private jumpToIssue(issue: ProcessedIssue) {
    const editor = this.resolveEditor();
    if (!editor) {
      new Notice('Open the note in edit mode to jump to the issue.');
      return;
    }
    const docLength = editor.getValue().length;
    const fromOffset = clamp(issue.start, 0, docLength);
    const toOffset = Math.max(fromOffset + 1, clamp(issue.end, 0, docLength));
    const from = editor.offsetToPos(fromOffset);
    const to = editor.offsetToPos(toOffset);
    editor.focus();
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  private resolveEditor(): Editor | null {
    if (this.lastEditor) {
      return this.lastEditor;
    }
    if (!this.lastFilePath) {
      return null;
    }
    let found: Editor | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) {
        return;
      }
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === this.lastFilePath) {
        found = view.editor;
      }
    });
    return found;
  }

  private applySuggestion(issue: ProcessedIssue) {
    const editor = this.resolveEditor();
    if (!editor) {
      new Notice('편집 가능한 노트에서만 제안을 적용할 수 있습니다.');
      return;
    }
    if (!issue.suggestion) {
      return;
    }
    const docLength = editor.getValue().length;
    const fromOffset = clamp(issue.start, 0, docLength);
    const toOffset = clamp(issue.end, 0, docLength);
    const to = Math.max(fromOffset, toOffset);
    const from = Math.min(fromOffset, toOffset);
    editor.replaceRange(issue.suggestion, editor.offsetToPos(from), editor.offsetToPos(to));
    // After apply, move cursor to end of inserted text and trigger reanalysis
    const newPos = editor.offsetToPos(from + issue.suggestion.length);
    editor.setCursor(newPos);
    const file = this.app.workspace.getActiveFile();
    if (file) {
      void this.plugin.runAnalysisForFile(file, false);
    }
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
            this.plugin.updateStatus(
              this.plugin.settings.analysisTrigger === 'realtime' ? 'Idle' : 'Manual'
            );
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
      .setDesc('Lower values trigger checks sooner after edits (realtime mode).')
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

    new Setting(containerEl)
      .setName('Cooldown between analyses (ms)')
      .setDesc('Minimum gap between API calls per note (realtime mode).')
      .addSlider((slider) =>
        slider
          .setLimits(1000, 20000, 500)
          .setValue(this.plugin.settings.cooldownMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.cooldownMs = value;
            await this.plugin.saveBkgaSettings();
          })
      );

    new Setting(containerEl)
      .setName('Analysis mode')
      .setDesc('Realtime = auto on edits; Manual = run only via command.')
      .addDropdown((dropdown) => {
        dropdown.addOption('realtime', 'Realtime (auto)');
        dropdown.addOption('manual', 'Manual (command only)');
        dropdown.setValue(this.plugin.settings.analysisTrigger);
        dropdown.onChange(async (value) => {
          this.plugin.settings.analysisTrigger = value as 'realtime' | 'manual';
          await this.plugin.saveBkgaSettings();
          this.plugin.updateStatus(
            this.plugin.settings.analysisTrigger === 'realtime' ? 'Idle' : 'Manual'
          );
        });
      });
  }
}

function createDecorationExtension(plugin: BareunObsidianPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private lastFilePath: string | null = null;

      constructor(private view: EditorView) {
        plugin.trackEditorView(view);
        this.decorations = this.buildDecorations();
      }

      update(update: ViewUpdate) {
        const currentPath = getFilePath(this.view);
        if (currentPath !== this.lastFilePath) {
          this.decorations = this.buildDecorations();
          return;
        }

        const diagnosticsChanged = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(diagnosticsEffect))
        );

        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }

        if (diagnosticsChanged) {
          this.decorations = this.buildDecorations();
        }
      }

      destroy() {
        plugin.untrackEditorView(this.view);
      }

      private buildDecorations(): DecorationSet {
        const filePath = getFilePath(this.view);
        if (!filePath) {
          this.lastFilePath = null;
          return Decoration.none;
        }
        const issues = plugin.getDiagnostics(filePath).filter((i) => plugin.isCategoryEnabled(i));
        if (!issues.length) {
          this.lastFilePath = filePath;
          return Decoration.none;
        }
        const builder = new RangeSetBuilder<Decoration>();
        const docLength = this.view.state.doc.length;
        const sorted = issues
          .map((iss) => {
            const from = clamp(iss.start, 0, docLength);
            const to = clamp(iss.end, 0, docLength);
            return { iss, from, to };
          })
          .filter((item) => item.to > item.from)
          .sort((a, b) => (a.from - b.from !== 0 ? a.from - b.from : a.to - b.to));

        for (const { iss, from, to } of sorted) {
          const deco = Decoration.mark({
            class: `bkga-underline ${categoryToClass(iss.category)}`,
            attributes: {
              title:
                iss.suggestion && iss.suggestion !== ''
                  ? `${iss.message}\nSuggestion: ${iss.suggestion}`
                  : iss.message,
            },
          });
          builder.add(from, to, deco);
        }
        this.lastFilePath = filePath;
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

function categoryKey(category: string): string {
  const normalized = (category || '').toUpperCase();
  if (normalized.includes('SPELLING') || normalized.includes('맞춤법') || normalized.includes('TYPO')) {
    return 'TYPO';
  }
  if (normalized.includes('SPACING') || normalized.includes('띄어쓰기')) {
    return 'SPACING';
  }
  if (normalized.includes('STANDARD') || normalized.includes('표준어')) {
    return 'STANDARD';
  }
  if (normalized.includes('STATISTICAL') || normalized.includes('통계')) {
    return 'STATISTICAL';
  }
  return 'DEFAULT';
}

function categoryLabel(category: string): string {
  const normalized = (category || '').toUpperCase();
  if (normalized.includes('SPELLING') || normalized.includes('맞춤법') || normalized.includes('TYPO')) {
    return '맞춤법';
  }
  if (normalized.includes('SPACING') || normalized.includes('띄어쓰기')) {
    return '띄어쓰기';
  }
  if (normalized.includes('STANDARD') || normalized.includes('표준어')) {
    return '표준어';
  }
  if (normalized.includes('STATISTICAL') || normalized.includes('통계')) {
    return '통계';
  }
  return '기타';
}

function categoryTooltip(category: string): string {
  const normalized = (category || '').toUpperCase();
  if (normalized.includes('SPELLING') || normalized.includes('맞춤법') || normalized.includes('TYPO')) {
    return '맞춤법/오타';
  }
  if (normalized.includes('SPACING') || normalized.includes('띄어쓰기')) {
    return '띄어쓰기';
  }
  if (normalized.includes('STANDARD') || normalized.includes('표준어')) {
    return '표준어';
  }
  if (normalized.includes('STATISTICAL') || normalized.includes('통계')) {
    return '통계적 제안';
  }
  return '기타';
}

function getFilePath(view: EditorView): string | null {
  const info = view.state.field(editorInfoField, false) as { file?: TFile } | undefined;
  return info?.file?.path ?? null;
}

function offsetToLineCol(
  text: string,
  start: number,
  end: number
): { from: { line: number; ch: number }; to: { line: number; ch: number } } | null {
  if (start < 0 || end < 0 || start > text.length) {
    return null;
  }
  const clampedStart = clamp(start, 0, text.length);
  const clampedEnd = clamp(end, 0, text.length);
  return {
    from: offsetToPos(text, clampedStart),
    to: offsetToPos(text, clampedEnd),
  };
}

function offsetToPos(text: string, offset: number): { line: number; ch: number } {
  let line = 0;
  let ch = 0;
  for (let i = 0; i < offset; i++) {
    const c = text[i];
    if (c === '\n') {
      line++;
      ch = 0;
    } else {
      ch++;
    }
  }
  return { line: line + 1, ch: ch + 1 };
}
