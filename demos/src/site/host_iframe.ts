import * as crdts from "compoventuals";

// TODO: permissionless iframe (no communication except
// what we allow).  Although some of this code (e.g. Shadow
// DOM) stuff should remain on the permissionless side.
// TODO: dynamic loading.
// TODO: test with multiple instances.

/**
 * BroadcastNetwork that talks to the host page using
 * window.postMessage.
 */
class HostIframeNetwork implements crdts.BroadcastNetwork {
  onReceive!: (message: Uint8Array) => void;

  constructor() {
    window.addEventListener(
      "message",
      (event) => {
        if (event.source !== window.parent) return;
        if (event.data.type !== "message") return;
        this.onReceive(event.data.message);
      },
      false
    );
  }

  send(message: Uint8Array): void {
    // TODO: insecure targetOrigin
    window.parent.postMessage({ type: "message", message }, "*");
  }

  save(): Uint8Array {
    // Nothing to save; host will save its own BroadcastNetwork.
    return new Uint8Array();
  }

  load(_saveData: Uint8Array): void {}
}

const topDiv = document.getElementById("topDiv")!;
const shadowRoot = topDiv.attachShadow({ mode: "open" });

const client = new crdts.Runtime(new HostIframeNetwork());

// We first listen for the ContainerSource string.
function containerSourceListener(event: MessageEvent<any>) {
  if (event.source !== window.parent) return;
  if (event.data.type !== "containerSource") return;
  window.removeEventListener("message", containerSourceListener);
  const containerSourceJs = event.data.containerSourceJs as string;
  // Dynamically import the javascript.
  // Based on https://stackoverflow.com/a/57255653
  const importUrl =
    "data:text/javascript;base64," +
    btoa(unescape(encodeURIComponent(containerSourceJs)));
  // We need this webpackIgnore magic comment or else webpack
  // will try to do its thing to the import statement, compiling
  // it into a __webpack_require, which is incorrect: it should
  // be compiled as-is.
  // From https://github.com/webpack/webpack/issues/4175#issuecomment-770769441
  // import(/* webpackIgnore: true */ importUrl).then((module) => {
  // Actually, that's not working either (it converts import
  // to require).  So for now I will use this eval hack.
  // TODO: do this the proper way / provide intended final
  // name (on window) as a string.
  eval("import(importUrl)").then((imported: any) => {
    const containerSource = (window as any)["compoventuals-demos"];
    if (!crdts.isContainerSource(containerSource)) {
      throw new Error("module.default is not a ContainerSource");
    }
    // Use containerSource.
    containerSource.attachNewContainer(shadowRoot, (topLevelCrdt) =>
      client.registerCrdt("container", topLevelCrdt)
    );
    // Now we are ready to receive Crdt messages.
    // TODO: insecure targetOrigin
    window.parent.postMessage({ type: "readyForMessages" }, "*");
  });
}
window.addEventListener("message", containerSourceListener, false);

// Let the host know that we are now listening for
// the container.
// TODO: insecure targetOrigin
window.parent.postMessage({ type: "readyForContainer" }, "*");
