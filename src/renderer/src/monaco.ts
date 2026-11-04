import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

// Bundle Monaco and its language workers locally so the packaged IDE does not need a CDN.
// This module is loaded lazily so the ~9 MB editor never blocks app start-up.
loader.config({ monaco })
;(self as unknown as { MonacoEnvironment: { getWorker: (_moduleId: string, label: string) => Worker } }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
    return new EditorWorker()
  },
}

monaco.editor.defineTheme('nexus-glass', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b6889', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c4a7ff' },
    { token: 'string', foreground: '9fd8b4' },
    { token: 'number', foreground: 'f0b98a' },
    { token: 'type', foreground: '8fc3ff' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editorGutter.background': '#00000000',
    'minimap.background': '#00000000',
    'editor.lineHighlightBackground': '#ffffff07',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#4a4862',
    'editorLineNumber.activeForeground': '#b3aacf',
    'editor.selectionBackground': '#7c5cf042',
    'editor.inactiveSelectionBackground': '#7c5cf022',
    'editorCursor.foreground': '#c2b0ff',
    'editorIndentGuide.background1': '#ffffff0d',
    'editorIndentGuide.activeBackground1': '#ffffff24',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'scrollbarSlider.activeBackground': '#ffffff30',
    'editorWidget.background': '#1c1a2a',
    'editorWidget.border': '#ffffff1a',
    'diffEditor.insertedTextBackground': '#3ccf8a22',
    'diffEditor.removedTextBackground': '#ff6b8a22',
  },
})

export { default as Editor, DiffEditor } from '@monaco-editor/react'
