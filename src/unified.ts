import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import {
  EditorState,
  Text,
  Prec,
  RangeSetBuilder,
  StateField,
  StateEffect,
  Range,
  RangeSet,
  ChangeSet,
  Extension,
} from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { language, highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { Chunk, defaultDiffConfig } from "./chunk";
import { computeChunks, ChunkField, mergeConfig } from "./merge";
import { Change, DiffConfig } from "./diff";
import { decorateChunks, collapseUnchanged, changedText } from "./deco";
import { baseTheme } from "./theme";

interface UnifiedMergeConfig {
  /// The other document to compare the editor content with.
  original: Text | string;
  /// By default, the merge view will mark inserted and deleted text
  /// in changed chunks. Set this to false to turn that off.
  highlightChanges?: boolean;
  /// Controls whether a gutter marker is shown next to changed lines.
  gutter?: boolean;
  /// By default, deleted chunks are highlighted using the main
  /// editor's language. Since these are just fragments, not full
  /// documents, this doesn't always work well. Set this option to
  /// false to disable syntax highlighting for deleted lines.
  syntaxHighlightDeletions?: boolean;
  /// When enabled (off by default), chunks that look like they
  /// contain only inline changes will have the changes displayed
  /// inline, rather than as separate deleted/inserted lines.
  allowInlineDiffs?: boolean;
  /// Deleted blocks larger than this size do not get
  /// syntax-highlighted. Defaults to 3000.
  syntaxHighlightDeletionsMaxLength?: number;
  /// Controls whether accept/reject buttons are displayed for each
  /// changed chunk. Defaults to true. When set to a function, that
  /// function is used to render the buttons.
  mergeControls?:
    | boolean
    | ((
        type: "reject" | "accept",
        action: (e: MouseEvent) => void
      ) => HTMLElement);
  /// Pass options to the diff algorithm. By default, the merge view
  /// sets [`scanLimit`](#merge.DiffConfig.scanLimit) to 500.
  diffConfig?: DiffConfig;
  /// When given, long stretches of unchanged text are collapsed.
  /// `margin` gives the number of lines to leave visible after/before
  /// a change (default is 3), and `minSize` gives the minimum amount
  /// of collapsible lines that need to be present (defaults to 4).
  collapseUnchanged?: { margin?: number; minSize?: number };
  /// Optional custom inverted effects extension for undo/redo support.
  /// If provided, this will be used instead of the default undoableChunkOperations.
  /// Set to `false` to disable undo support entirely.
  invertedEffects?: typeof invertedEffects;
}

const deletedChunkGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-deletedLineGutter";
})();

const unifiedChangeGutter = Prec.low(
  gutter({
    class: "cm-changeGutter",
    markers: (view) => view.plugin(decorateChunks)?.gutter || RangeSet.empty,
    widgetMarker: (_view, widget) =>
      widget instanceof DeletionWidget ? deletedChunkGutterMarker : null,
  })
);

/// Create an extension that causes the editor to display changes
/// between its content and the given original document. Changed
/// chunks will be highlighted, with uneditable widgets displaying the
/// original text displayed above the new text.
export function unifiedMergeView(config: UnifiedMergeConfig) {
  let orig =
    typeof config.original == "string"
      ? Text.of(config.original.split(/\r?\n/))
      : config.original;
  let diffConf = config.diffConfig || defaultDiffConfig;

  const undoableChunkOperations = createUndoableChunkOperations(
    config.invertedEffects || invertedEffects
  );

  return [
    Prec.low(decorateChunks),
    deletedChunks,
    baseTheme,
    undoableChunkOperations,
    EditorView.editorAttributes.of({ class: "cm-merge-b" }),
    computeChunks.of((chunks, tr) => {
      let updateDoc = tr.effects.find((e) => e.is(updateOriginalDoc));
      let acceptEffect = tr.effects.find((e) => e.is(acceptChunkEffect));
      let rejectEffect = tr.effects.find((e) => e.is(rejectChunkEffect));
      let generateEffect = tr.effects.find((e) => e.is(generateCodeEffect));
      if (updateDoc)
        chunks = Chunk.updateA(
          chunks,
          updateDoc.value.doc,
          tr.startState.doc,
          updateDoc.value.changes,
          diffConf
        );
      if (acceptEffect)
        chunks = Chunk.updateA(
          chunks,
          acceptEffect.value.changes.apply(tr.startState.field(originalDoc)),
          tr.startState.doc,
          acceptEffect.value.changes,
          diffConf
        );
      if (generateEffect) {
        // When generating code, rebuild chunks from original to the new document
        // The document changes will be applied by the transaction, so we use tr.newDoc
        chunks = Chunk.build(tr.state.field(originalDoc), tr.newDoc, diffConf);
      }
      if (rejectEffect || (chunks.length && tr.docChanged)) {
        // For reject effects or document changes and there are chunks, update the B side (current document)
        chunks = Chunk.updateB(
          chunks,
          tr.state.field(originalDoc),
          tr.newDoc,
          tr.changes,
          diffConf
        );
      }
      return chunks;
    }),
    mergeConfig.of({
      highlightChanges: config.highlightChanges !== false,
      markGutter: config.gutter !== false,
      syntaxHighlightDeletions: config.syntaxHighlightDeletions !== false,
      syntaxHighlightDeletionsMaxLength: 3000,
      mergeControls: config.mergeControls ?? true,
      overrideChunk: config.allowInlineDiffs ? overrideChunkInline : undefined,
      side: "b",
    }),
    originalDoc.init(() => orig),
    config.gutter !== false ? unifiedChangeGutter : [],
    config.collapseUnchanged ? collapseUnchanged(config.collapseUnchanged) : [],
    ChunkField.init((state) => Chunk.build(orig, state.doc, diffConf)),
  ];
}

/// The state effect used to signal changes in the original doc in a
/// unified merge view.
export const updateOriginalDoc = StateEffect.define<{
  doc: Text;
  changes: ChangeSet;
}>();

/// State effect for accepting a chunk (making current content the new original)
export const acceptChunkEffect = StateEffect.define<{
  chunkFromA: number;
  chunkToA: number;
  chunkFromB: number;
  chunkToB: number;
  originalDoc: Text;
  currentContent: string;
  changes: ChangeSet;
}>({
  map: (value, change) => {
    let fromB = change.mapPos(value.chunkFromB);
    let toB = change.mapPos(value.chunkToB);
    return fromB < toB
      ? {
          ...value,
          chunkFromB: fromB,
          chunkToB: toB,
        }
      : undefined;
  },
});

/// State effect for rejecting a chunk (reverting to original content)
export const rejectChunkEffect = StateEffect.define<{
  chunkFromA: number;
  chunkToA: number;
  chunkFromB: number;
  chunkToB: number;
  originalContent: string;
  currentContent: string;
  changes: ChangeSet;
}>({
  map: (value, change) => {
    let fromB = change.mapPos(value.chunkFromB);
    let toB = change.mapPos(value.chunkToB);
    return fromB < toB
      ? {
          ...value,
          chunkFromB: fromB,
          chunkToB: toB,
        }
      : undefined;
  },
});

/// State effect for dispatching generated code that triggers diff display
export const generateCodeEffect = StateEffect.define<{
  generatedCode: string;
  replaceAll?: boolean;
  insertAt?: number;
}>();

/// Create an effect that, when added to a transaction on a unified
/// merge view, will update the original document that's being compared against.
export function originalDocChangeEffect(
  state: EditorState,
  changes: ChangeSet
): StateEffect<{ doc: Text; changes: ChangeSet }> {
  return updateOriginalDoc.of({
    doc: changes.apply(getOriginalDoc(state)),
    changes,
  });
}

/// Create a transaction that applies generated code and triggers diff display
export function applyGeneratedCode(
  view: EditorView,
  generatedCode: string,
  options: { replaceAll?: boolean; insertAt?: number } = {}
) {
  const { replaceAll = true, insertAt } = options;

  let changes;
  if (replaceAll) {
    // Replace entire document content
    changes = {
      from: 0,
      to: view.state.doc.length,
      insert: generatedCode,
    };
  } else if (insertAt !== undefined) {
    // Insert at specific position
    changes = {
      from: insertAt,
      to: insertAt,
      insert: generatedCode,
    };
  } else {
    // Insert at cursor position
    const pos = view.state.selection.main.head;
    changes = {
      from: pos,
      to: pos,
      insert: generatedCode,
    };
  }

  view.dispatch({
    changes,
    effects: generateCodeEffect.of({
      generatedCode,
      replaceAll,
      insertAt,
    }),
    userEvent: "generate.code",
  });
}

const originalDoc = StateField.define<Text>({
  create: () => Text.empty,
  update(doc, tr) {
    for (let e of tr.effects) {
      if (e.is(updateOriginalDoc)) {
        doc = e.value.doc;
      } else if (e.is(acceptChunkEffect)) {
        doc = e.value.changes.apply(doc);
      } else if (e.is(rejectChunkEffect)) {
        // For reject, the original document doesn't change
        // The effect is used for tracking undo state
      }
    }
    return doc;
  },
});

/// Get the original document from a unified merge editor's state.
export function getOriginalDoc(state: EditorState): Text {
  return state.field(originalDoc);
}

/// Default inverted effects mapping for undoable accept/reject operations
export function createUndoableChunkOperations(
  _invertedEffects: typeof invertedEffects
): Extension {
  return _invertedEffects.of((tr) => {
    let found: StateEffect<any>[] = [];
    for (let e of tr.effects) {
      if (e.is(acceptChunkEffect)) {
        // To undo accept: restore the original document
        found.push(
          updateOriginalDoc.of({
            doc: e.value.originalDoc,
            changes: e.value.changes.invert(tr.startState.field(originalDoc)),
          })
        );
      } else if (e.is(rejectChunkEffect)) {
        // To undo reject: restore the content that was rejected
        found.push(
          rejectChunkEffect.of({
            chunkFromA: e.value.chunkFromA,
            chunkToA: e.value.chunkToA,
            chunkFromB: e.value.chunkFromB,
            chunkToB: e.value.chunkToB,
            originalContent: e.value.currentContent, // Swap: restore what was there before
            currentContent: e.value.originalContent,
            changes: e.value.changes.invert(tr.startState.doc),
          })
        );
      }
    }
    return found;
  });
}

const DeletionWidgets: WeakMap<readonly Change[], Decoration> = new WeakMap();

class DeletionWidget extends WidgetType {
  dom: HTMLElement | null = null;
  constructor(readonly buildDOM: (view: EditorView) => HTMLElement) {
    super();
  }
  eq(other: DeletionWidget) {
    return this.dom == other.dom;
  }
  toDOM(view: EditorView) {
    return this.dom || (this.dom = this.buildDOM(view));
  }
}

function deletionWidget(
  state: EditorState,
  chunk: Chunk,
  hideContent: boolean
) {
  let known = DeletionWidgets.get(chunk.changes);
  if (known) return known;

  let buildDOM = (view: EditorView) => {
    let {
      highlightChanges,
      syntaxHighlightDeletions,
      syntaxHighlightDeletionsMaxLength,
      mergeControls,
    } = state.facet(mergeConfig);
    let dom = document.createElement("div");
    dom.className = "cm-deletedChunk";
    if (mergeControls) {
      let buttons = dom.appendChild(document.createElement("div"));
      buttons.className = "cm-chunkButtons";
      let onAccept = (e: MouseEvent) => {
        e.preventDefault();
        acceptChunk(view, view.posAtDOM(dom));
      };
      let onReject = (e: MouseEvent) => {
        e.preventDefault();
        rejectChunk(view, view.posAtDOM(dom));
      };
      if (typeof mergeControls == "function") {
        buttons.appendChild(mergeControls("accept", onAccept));
        buttons.appendChild(mergeControls("reject", onReject));
      } else {
        let accept = buttons.appendChild(document.createElement("button"));
        accept.name = "accept";
        accept.textContent = state.phrase("Accept");
        accept.onmousedown = onAccept;
        let reject = buttons.appendChild(document.createElement("button"));
        reject.name = "reject";
        reject.textContent = state.phrase("Reject");
        reject.onmousedown = onReject;
      }
    }
    if (hideContent || chunk.fromA >= chunk.toA) return dom;

    let text = view.state
      .field(originalDoc)
      .sliceString(chunk.fromA, chunk.endA);
    let lang = syntaxHighlightDeletions && state.facet(language);
    let line: HTMLElement = makeLine();
    let changes = chunk.changes,
      changeI = 0,
      inside = false;
    function makeLine() {
      let div = dom.appendChild(document.createElement("div"));
      div.className = "cm-deletedLine";
      return div.appendChild(document.createElement("del"));
    }
    function add(from: number, to: number, cls: string) {
      for (let at = from; at < to; ) {
        if (text.charAt(at) == "\n") {
          if (!line.firstChild) line.appendChild(document.createElement("br"));
          line = makeLine();
          at++;
          continue;
        }
        let nextStop = to,
          nodeCls = cls + (inside ? " cm-deletedText" : ""),
          flip = false;
        let newline = text.indexOf("\n", at);
        if (newline > -1 && newline < to) nextStop = newline;
        if (highlightChanges && changeI < changes.length) {
          let nextBound = Math.max(
            0,
            inside ? changes[changeI].toA : changes[changeI].fromA
          );
          if (nextBound <= nextStop) {
            nextStop = nextBound;
            if (inside) changeI++;
            flip = true;
          }
        }
        if (nextStop > at) {
          let node = document.createTextNode(text.slice(at, nextStop));
          if (nodeCls) {
            let span = line.appendChild(document.createElement("span"));
            span.className = nodeCls;
            span.appendChild(node);
          } else {
            line.appendChild(node);
          }
          at = nextStop;
        }
        if (flip) inside = !inside;
      }
    }

    if (lang && chunk.toA - chunk.fromA <= syntaxHighlightDeletionsMaxLength!) {
      let tree = lang.parser.parse(text),
        pos = 0;
      highlightTree(
        tree,
        { style: (tags) => highlightingFor(state, tags) },
        (from, to, cls) => {
          if (from > pos) add(pos, from, "");
          add(from, to, cls);
          pos = to;
        }
      );
      add(pos, text.length, "");
    } else {
      add(0, text.length, "");
    }
    if (!line.firstChild) line.appendChild(document.createElement("br"));
    return dom;
  };
  let deco = Decoration.widget({
    block: true,
    side: -1,
    widget: new DeletionWidget(buildDOM),
  });
  DeletionWidgets.set(chunk.changes, deco);
  return deco;
}

/// In a [unified](#merge.unifiedMergeView) merge view, accept the
/// chunk under the given position or the cursor. This chunk will no
/// longer be highlighted unless it is edited again.
export function acceptChunk(view: EditorView, pos?: number) {
  let { state } = view,
    at = pos ?? state.selection.main.head;
  let chunk = view.state
    .field(ChunkField)
    .find((ch) => ch.fromB <= at && ch.endB >= at);
  if (!chunk) return false;
  let insert = view.state.sliceDoc(
    chunk.fromB,
    Math.max(chunk.fromB, chunk.toB - 1)
  );
  let orig = view.state.field(originalDoc);
  if (chunk.fromB != chunk.toB && chunk.toA <= orig.length)
    insert += view.state.lineBreak;
  let changes = ChangeSet.of(
    { from: chunk.fromA, to: Math.min(orig.length, chunk.toA), insert },
    orig.length
  );

  view.dispatch({
    effects: acceptChunkEffect.of({
      chunkFromA: chunk.fromA,
      chunkToA: chunk.toA,
      chunkFromB: chunk.fromB,
      chunkToB: chunk.toB,
      originalDoc: orig,
      currentContent: insert,
      changes,
    }),
    userEvent: "accept",
  });
  return true;
}

/// In a [unified](#merge.unifiedMergeView) merge view, reject the
/// chunk under the given position or the cursor. Reverts that range
/// to the content it has in the original document.
export function rejectChunk(view: EditorView, pos?: number) {
  let { state } = view,
    at = pos ?? state.selection.main.head;
  let chunk = state
    .field(ChunkField)
    .find((ch) => ch.fromB <= at && ch.endB >= at);
  if (!chunk) return false;
  let orig = state.field(originalDoc);
  let insert = orig.sliceString(
    chunk.fromA,
    Math.max(chunk.fromA, chunk.toA - 1)
  );
  if (chunk.fromA != chunk.toA && chunk.toB <= state.doc.length)
    insert += state.lineBreak;

  let currentContent = state.sliceDoc(
    chunk.fromB,
    Math.max(chunk.fromB, chunk.toB - 1)
  );

  let changes = ChangeSet.of(
    {
      from: chunk.fromB,
      to: Math.min(state.doc.length, chunk.toB),
      insert,
    },
    state.doc.length
  );

  view.dispatch({
    changes: {
      from: chunk.fromB,
      to: Math.min(state.doc.length, chunk.toB),
      insert,
    },
    effects: rejectChunkEffect.of({
      chunkFromA: chunk.fromA,
      chunkToA: chunk.toA,
      chunkFromB: chunk.fromB,
      chunkToB: chunk.toB,
      originalContent: insert,
      currentContent: currentContent,
      changes,
    }),
    userEvent: "revert",
  });
  return true;
}

function buildDeletedChunks(state: EditorState) {
  let builder = new RangeSetBuilder<Decoration>();
  for (let ch of state.field(ChunkField)) {
    let hide =
      state.facet(mergeConfig).overrideChunk &&
      chunkCanDisplayInline(state, ch);
    builder.add(ch.fromB, ch.fromB, deletionWidget(state, ch, !!hide));
  }
  return builder.finish();
}

const deletedChunks = StateField.define<DecorationSet>({
  create: (state) => buildDeletedChunks(state),
  update(deco, tr) {
    return tr.state.field(ChunkField, false) !=
      tr.startState.field(ChunkField, false)
      ? buildDeletedChunks(tr.state)
      : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const InlineChunkCache = new WeakMap<
  Chunk,
  readonly Range<Decoration>[] | null
>();

function chunkCanDisplayInline(
  state: EditorState,
  chunk: Chunk
): readonly Range<Decoration>[] | null {
  let result = InlineChunkCache.get(chunk);
  if (result !== undefined) return result;

  result = null;
  let a = state.field(originalDoc),
    b = state.doc;
  let linesA = a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1;
  let linesB = b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1;
  abort: if (linesA == linesB && linesA < 10) {
    let deco: Range<Decoration>[] = [],
      deleteCount = 0;
    let bA = chunk.fromA,
      bB = chunk.fromB;
    for (let ch of chunk.changes) {
      if (ch.fromA < ch.toA) {
        deleteCount += ch.toA - ch.fromA;
        let deleted = a.sliceString(bA + ch.fromA, bA + ch.toA);
        if (/\n/.test(deleted)) break abort;
        deco.push(
          Decoration.widget({
            widget: new InlineDeletion(deleted),
            side: -1,
          }).range(bB + ch.fromB)
        );
      }
      if (ch.fromB < ch.toB) {
        deco.push(changedText.range(bB + ch.fromB, bB + ch.toB));
      }
    }
    if (deleteCount < chunk.endA - chunk.fromA - linesA * 2) result = deco;
  }

  InlineChunkCache.set(chunk, result);
  return result;
}

class InlineDeletion extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: InlineDeletion) {
    return this.text == other.text;
  }

  toDOM(_view: EditorView) {
    let elt = document.createElement("del");
    elt.className = "cm-deletedText";
    elt.textContent = this.text;
    return elt;
  }
}

const inlineChangedLineGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-inlineChangedLineGutter";
})();
const inlineChangedLine = Decoration.line({ class: "cm-inlineChangedLine" });

function overrideChunkInline(
  state: EditorState,
  chunk: Chunk,
  builder: RangeSetBuilder<Decoration>,
  gutterBuilder: RangeSetBuilder<GutterMarker> | null
) {
  let inline = chunkCanDisplayInline(state, chunk),
    i = 0;
  if (!inline) return false;
  for (let line = state.doc.lineAt(chunk.fromB); ; ) {
    if (gutterBuilder)
      gutterBuilder.add(line.from, line.from, inlineChangedLineGutterMarker);
    builder.add(line.from, line.from, inlineChangedLine);
    while (i < inline.length && inline[i].to <= line.to) {
      let r = inline[i++];
      builder.add(r.from, r.to, r.value);
    }
    if (line.to >= chunk.endB) break;
    line = state.doc.lineAt(line.to + 1);
  }
  return true;
}
