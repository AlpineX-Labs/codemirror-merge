# @codemirror/merge [![NPM version](https://img.shields.io/npm/v/@codemirror/merge.svg)](https://www.npmjs.org/package/@codemirror/merge)

[ [**WEBSITE**](https://codemirror.net/) | [**DOCS**](https://codemirror.net/docs/ref/#merge) | [**ISSUES**](https://github.com/codemirror/dev/issues) | [**FORUM**](https://discuss.codemirror.net/c/next/) | [**CHANGELOG**](https://github.com/codemirror/merge/blob/main/CHANGELOG.md) ]

This package implements a merge interface for the
[CodeMirror](https://codemirror.net/) code editor.

The [project page](https://codemirror.net/) has more information, a
number of [examples](https://codemirror.net/examples/) and the
[documentation](https://codemirror.net/docs/ref/#merge).

This code is released under an
[MIT license](https://github.com/codemirror/merge/tree/main/LICENSE).

We aim to be an inclusive, welcoming community. To make that explicit,
we have a [code of
conduct](http://contributor-covenant.org/version/1/1/0/) that applies
to communication around the project.

## Usage

A split merge view can be created like this:

```javascript
import {MergeView} from "@codemirror/merge"
import {EditorView, basicSetup} from "codemirror"
import {EditorState} from "@codemirror/state"

let doc = `one
two
three
four
five`

const view = new MergeView({
  a: {
    doc,
    extensions: basicSetup
  },
  b: {
    doc: doc.replace(/t/g, "T") + "\nSix",
    extensions: [
      basicSetup,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true)
    ]
  },
  parent: document.body
})
```

Or a unified view like this:

```javascript
import {EditorView, basicSetup} from "codemirror"
import {unifiedMergeView} from "@codemirror/merge"

const view = new EditorView({
  parent: document.body,
  doc: "one\ntwo\nthree\nfour",
  extensions: [
    basicSetup,
    unifiedMergeView({
      original: "one\n...\nfour"
    })
  ]
})
```

## Fork

This Fork fixes undo/redo operation using (invertedEffects pattern)[https://codemirror.net/examples/inverted-effect/]

### What's Been Implemented
1. New StateEffect for Accept Operations
acceptChunkEffect: A new StateEffect that tracks chunk accept operations with proper position mapping
Stores chunk boundaries, original document state, and the changes being applied
2. Inverted Effects for Undo Support
undoableChunkOperations: Uses invertedEffects.of() to define how accept operations can be undone
When undoing an accept operation, it restores the original document state
3. Updated Accept/Reject Functions
acceptChunk: Now uses the acceptChunkEffect instead of directly updating the original document
rejectChunk: Remains largely the same since document changes are already undoable by CodeMirror's built-in undo system
4. Enhanced State Management
Updated the originalDoc state field to handle the new accept effects
Modified the computeChunks function to properly recompute diffs when accept effects are applied
Added the inverted effects extension to the unifiedMergeView extension

### How It Works

#### Accept Operation:
When a user clicks "Accept" on a chunk, it creates an acceptChunkEffect
This effect updates the original document and is automatically tracked by the history system
The inverse operation (restoring the previous original document state) is stored for undo

#### Reject Operation:
Directly modifies the current document content (reverting to original)
Uses CodeMirror's built-in undo mechanism since it's just a document change

#### Undo Support:
Undo Accept: Restores the original document to its previous state before the accept
Undo Reject: Uses standard document undo to restore the content that was rejected
