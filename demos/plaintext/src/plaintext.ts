import * as collabs from "@collabs/collabs";
import { CRDTContainer } from "@collabs/container";

(async function () {
  const container = new CRDTContainer();

  const text = container.registerCollab("text", collabs.Pre(collabs.CText)());

  await container.load();

  const textarea = document.getElementById("textarea") as HTMLTextAreaElement;
  textarea.value = text.toString(); // Use loaded state here.

  // Display text changes
  text.on("Any", () => {
    textarea.value = text.toString();
    updateSelection();
  });

  // TODO: shared cursors

  const myStartCursor = new collabs.LocalCursor(text, 0);
  const myEndCursor = new collabs.LocalCursor(text, 0);
  function updateCursors() {
    // Need to do this on a delay because the event doesn't
    // due its default action (updating the handler) until
    // after the event handlers.
    setTimeout(() => {
      myStartCursor.index = textarea.selectionStart;
      myEndCursor.index = textarea.selectionEnd;
    }, 0);
  }
  function updateSelection() {
    textarea.selectionStart = myStartCursor.index;
    textarea.selectionEnd = myEndCursor.index;
  }

  window.addEventListener("selectionchange", updateCursors);
  textarea.addEventListener("mousedown", updateCursors);
  textarea.addEventListener("mousemove", (e) => {
    if (e.buttons === 1) updateCursors();
  });
  textarea.addEventListener("mouseclick", updateCursors);

  // Change the text when a key is pressed in textarea
  textarea.addEventListener("keydown", (e) => {
    const startIndex = myStartCursor.index;
    const endIndex = myEndCursor.index;
    if (e.key === "Backspace") {
      if (endIndex > startIndex) {
        text.delete(startIndex, endIndex - startIndex);
        myEndCursor.index = startIndex;
      } else if (endIndex === startIndex && startIndex > 0) {
        text.delete(startIndex - 1);
        myStartCursor.index = startIndex - 1;
      }
    } else if (e.key === "Delete") {
      if (endIndex > startIndex) {
        text.delete(startIndex, endIndex - startIndex);
        myEndCursor.index = startIndex;
      } else if (
        endIndex === startIndex &&
        startIndex < textarea.value.length
      ) {
        text.delete(startIndex);
      }
    } else if (e.key === "Enter") {
      type("\n", startIndex, endIndex);
    } else if (e.key === "Tab") {
      // TODO: proper tab behavior
      type("    ", startIndex, endIndex);
    } else if (shouldType(e)) {
      type(e.key, startIndex, endIndex);
    } else {
      // Assume it's either irrelevant or selection related
      updateCursors();
      return; // Don't updateSelection or preventDefault.
      // Ctrl+V, Ctrl+X dispatch paste/cut events, like when
      // using the mouse menu versions, which we handle below.
      // Ctrl+C doesn't need to be handled (default works fine.)
      // So we don't need cases for these.
    }

    updateSelection();
    // Don't let the browser type the key, we do it for them
    e.preventDefault();
  });

  function type(str: string, startIndex: number, endIndex: number) {
    if (startIndex < endIndex) {
      // Delete current selection
      text.delete(startIndex, endIndex - startIndex);
    }
    text.insert(startIndex, ...str);
    myStartCursor.index = startIndex + str.length;
    myEndCursor.index = startIndex + str.length;
  }

  function shouldType(e: KeyboardEvent): boolean {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  textarea.addEventListener("paste", (e) => {
    if (e.clipboardData) {
      const pasted = e.clipboardData.getData("text");
      type(pasted, myStartCursor.index, myEndCursor.index);
      updateSelection();
    }
    e.preventDefault();
  });

  textarea.addEventListener("cut", () => {
    const startIndex = myStartCursor.index;
    const endIndex = myEndCursor.index;
    if (startIndex < endIndex) {
      const selected = textarea.value.slice(startIndex, endIndex);
      navigator.clipboard.writeText(selected);
      text.delete(startIndex, endIndex - startIndex);
    }
  });

  // TODO: allow drag+drop text?  Currently we just
  // disable it.
  textarea.addEventListener("dragstart", (e) => {
    e.preventDefault();
  });
  textarea.addEventListener("drop", (e) => {
    e.preventDefault();
  });

  // Ready.
  container.ready();
})();
