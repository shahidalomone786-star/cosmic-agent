import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';

type CursorPosition = { line: number; column: number };

type FileCodeEditorProps = {
  filePath: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onCursorChange: (position: CursorPosition) => void;
};

function languageForPath(filePath: string) {
  const extension = filePath.toLowerCase().split('.').pop() ?? '';
  const name = filePath.toLowerCase().split('/').pop() ?? '';

  if (extension === 'ts' || extension === 'tsx') return javascript({ typescript: true, jsx: extension === 'tsx' });
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return javascript({ jsx: extension === 'jsx' });
  if (extension === 'json' || name === 'tsconfig') return json();
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return markdown();
  if (extension === 'yaml' || extension === 'yml') return yaml();
  if (extension === 'css' || extension === 'scss' || extension === 'less') return css();
  if (extension === 'html' || extension === 'htm' || extension === 'svg') return html();
  return null;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '350px',
    color: '#d9e6db',
    backgroundColor: 'transparent',
    fontFamily: 'var(--font-code)',
    fontSize: '12px',
  },
  '.cm-scroller': {
    minHeight: '350px',
    overflow: 'auto',
    fontFamily: 'inherit',
    lineHeight: '1.7',
  },
  '.cm-content': {
    minHeight: '350px',
    padding: '18px 20px',
    caretColor: '#e19a70',
    tabSize: '2',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-gutters': {
    border: '0',
    borderRight: '1px solid rgba(144, 192, 181, .1)',
    color: '#78918a',
    backgroundColor: 'rgba(10, 27, 29, .42)',
    fontFamily: 'var(--font-code)',
    fontSize: '11px',
  },
  '.cm-gutter': {
    minWidth: '46px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '38px',
    padding: '0 8px 0 0',
    textAlign: 'right',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(62, 104, 91, .16)',
  },
  '.cm-activeLineGutter': {
    color: '#d9e6db',
    backgroundColor: 'rgba(91, 57, 44, .32)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(217, 138, 98, .24) !important',
  },
  '.cm-matchingBracket': {
    color: '#fff3dc !important',
    backgroundColor: 'rgba(217, 138, 98, .3)',
    outline: '1px solid rgba(217, 138, 98, .5)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#e19a70',
  },
  '.cm-tooltip': {
    border: '1px solid rgba(144, 192, 181, .25)',
    backgroundColor: '#10252a',
  },
  '.cm-placeholder': {
    color: '#78918a',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '&.cm-focused .cm-gutters': {
    backgroundColor: 'rgba(16, 37, 42, .65)',
  },
}, { dark: true });

export default function FileCodeEditor({ filePath, value, readOnly, onChange, onCursorChange }: FileCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const bridge = bridgeRef.current;

    const updateCursor = (state: EditorState) => {
      const position = state.doc.lineAt(state.selection.main.head);
      onCursorChangeRef.current({ line: position.number, column: state.selection.main.head - position.from + 1 });
    };
    const syncBridge = (text: string) => {
      if (bridge && bridge.value !== text) bridge.value = text;
    };

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          drawSelection(),
          history(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          languageForPath(filePath) ?? [],
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              syncBridge(text);
              onChangeRef.current(text);
            }
            if (update.docChanged || update.selectionSet) updateCursor(update.state);
          }),
          editorTheme,
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    const handleBridgeInput = () => {
      if (!bridge || readOnly) {
        syncBridge(view.state.doc.toString());
        return;
      }
      if (bridge.value !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: bridge.value } });
      }
    };
    bridge?.addEventListener('input', handleBridgeInput);
    syncBridge(value);
    updateCursor(view.state);

    return () => {
      bridge?.removeEventListener('input', handleBridgeInput);
      viewRef.current = null;
      view.destroy();
    };
  }, [filePath, readOnly]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (bridge && bridge.value !== value) bridge.value = value;
  }, [value]);

  return <div className="file-code-editor-shell">
    <textarea ref={bridgeRef} className="file-code-editor-input-bridge" defaultValue={value} tabIndex={-1} aria-hidden="true" data-testid="textarea-file-explorer-editor" />
    <div ref={containerRef} className="file-code-editor" data-testid="code-editor-file-explorer" aria-label={`Edit ${filePath}`} />
  </div>;
}